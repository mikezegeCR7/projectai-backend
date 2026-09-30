import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  Prisma,
  ResearchRun,
  Source,
  Evidence,
  SourceEvaluationStatus,
  SourceProvider,
  SourceDocumentStatus,
  EvidenceType,
  ClaimStatus,
  ClaimEvidenceRelationship,
} from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SearchGatewayService } from '../../../infrastructure/search/search-gateway.service';
import { SourceCandidate } from '../../../infrastructure/search/search-provider.interface';
import { SourceDocumentService } from '../../../infrastructure/content/source-document.service';
import { AiGatewayService } from '../../../infrastructure/ai/ai-gateway.service';
import {
  ClaimGroundingCheckClaimInput,
} from '../../../infrastructure/ai/roles/claim-grounding-check.role';
import { ExtractionScope, EvidenceAnalystItem } from '../../../infrastructure/ai/roles/evidence-analyst.role';
import {
  ResearchAnalystClaim,
  ResearchAnalystEvidenceRef,
  ResearchAnalystOutput,
} from '../../../infrastructure/ai/roles/research-analyst.role';
import {
  RESEARCH_QUEUE_NAME,
  RunResearchJobData,
} from '../../../infrastructure/queue/queue.constants';

/**
 * Relevance threshold above which a discovered candidate is auto-accepted.
 * Below it, it's stored as NEEDS_REVIEW rather than silently dropped —
 * RESEARCH-INTELLIGENCE.md §5 says evaluation information should be
 * preserved, not discarded. This is a coarse heuristic placeholder for
 * real Source Evaluation (a later slice), not a claim of true relevance
 * judgement.
 */
const AUTO_ACCEPT_THRESHOLD = 0.5;

// How much of a retrieved full text we actually send to the Evidence
// Analyst per source. Generous enough for a typical article/paper, small
// enough to keep prompt cost/latency bounded on Gemini's free tier. If
// truncated, the model is told so explicitly (see extractEvidence) —
// never silently.
const MAX_EVIDENCE_INPUT_CHARS = 18_000;

// The only gap category the Research Analyst can honestly assert — see
// buildKnowledge and research-analyst.role.ts.
const LIMITED_EVIDENCE_GAP_TYPE = 'LIMITED_EVIDENCE_FOUND';

const ABSTRACT_ONLY_LIMITATION =
  'Derived from the abstract only — full source text was not retrievable for this source.';

@Processor(RESEARCH_QUEUE_NAME)
export class ResearchRunProcessor extends WorkerHost {
  private readonly logger = new Logger(ResearchRunProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly searchGateway: SearchGatewayService,
    private readonly sourceDocuments: SourceDocumentService,
    private readonly aiGateway: AiGatewayService,
  ) {
    super();
  }

  async process(job: Job<RunResearchJobData>): Promise<void> {
    const { researchRunId } = job.data;

    const run = await this.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      include: { researchPlan: true },
    });

    if (!run) {
      this.logger.error(`Research run ${researchRunId} not found — dropping job.`);
      return;
    }

    // Idempotency: a completed run is a no-op even if the job is somehow
    // reprocessed (e.g. a stuck job re-added by hand). A cancelled run
    // never starts. ENGINEERING-RULES.md §8/§14: jobs must be retryable
    // without creating duplicate data.
    if (run.status === 'COMPLETED') {
      this.logger.log(`Research run ${researchRunId} already completed — skipping.`);
      return;
    }
    if (run.status === 'CANCELLED') {
      this.logger.log(`Research run ${researchRunId} is cancelled — skipping.`);
      return;
    }

    try {
      await this.prisma.researchRun.update({
        where: { id: researchRunId },
        data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() },
      });
      await this.emit(researchRunId, 'planning', 'Validating research plan.');

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      await this.emit(researchRunId, 'searching', 'Searching sources across providers.');
      const candidates = await this.searchGateway.discover(
        buildDiscoveryQuery(run.researchPlan),
      );

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      await this.emit(
        researchRunId,
        'evaluating',
        `Evaluating ${candidates.length} discovered candidate source(s).`,
        { candidateCount: candidates.length },
      );

      const sources = await this.persistSources(
        run.projectId,
        researchRunId,
        candidates,
      );

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      const accepted = sources.filter((s) => s.evaluationStatus === SourceEvaluationStatus.ACCEPTED);
      await this.emit(
        researchRunId,
        'retrieving',
        `Retrieving full text for ${accepted.length} accepted source(s).`,
        { acceptedCount: accepted.length },
      );
      const retrieval = await this.retrieveFullText(accepted);
      await this.emit(
        researchRunId,
        'retrieved',
        `Full text: ${retrieval.completed} completed, ${retrieval.abstractOnly} abstract-only, ${retrieval.failed} failed (of ${accepted.length} accepted source(s)).`,
        retrieval,
      );

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      const evidence = await this.extractEvidence(
        run.projectId,
        researchRunId,
        sources,
        retrieval.outcomes,
        run.researchPlan,
      );
      await this.emit(
        researchRunId,
        'extracting',
        `Captured ${evidence.length} evidence record(s) from accepted source(s).`,
        { evidenceCount: evidence.length },
      );

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      const sourceTitleById = new Map(sources.map((s) => [s.id, s.title]));
      const knowledge = await this.buildKnowledge(
        run.projectId,
        researchRunId,
        evidence,
        sourceTitleById,
        run.researchPlan,
      );
      await this.emit(
        researchRunId,
        'building_knowledge',
        knowledge.failed
          ? 'Knowledge-building step failed; claims, gaps and conflicts were not updated for this run.'
          : `Built ${knowledge.claimCount} claim(s), ${knowledge.gapCount} gap(s) and ${knowledge.conflictCount} conflict(s) from the extracted evidence.`,
        knowledge,
      );

      if (await this.wasCancelled(researchRunId)) return this.recordCancelled(researchRunId);

      await this.emit(
        researchRunId,
        'completed',
        `Research run completed with ${sources.length} source(s), ${evidence.length} evidence record(s), and ${knowledge.claimCount} claim(s) stored.`,
        { sourceCount: sources.length, evidenceCount: evidence.length, ...knowledge },
      );
      await this.prisma.researchRun.update({
        where: { id: researchRunId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Research run ${researchRunId} failed: ${message}`);
      await this.emit(researchRunId, 'failed', message);
      await this.prisma.researchRun.update({
        where: { id: researchRunId },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          errorCode: 'RESEARCH_RUN_FAILED',
          errorMessage: message.slice(0, 1000),
        },
      });
      // Rethrow so BullMQ applies its retry/backoff policy — a transient
      // network failure should get another attempt, not a silent stop.
      throw error;
    }
  }

  private async wasCancelled(researchRunId: string): Promise<boolean> {
    const current = await this.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      select: { status: true },
    });
    return current?.status === 'CANCELLED';
  }

  private async recordCancelled(researchRunId: string): Promise<void> {
    await this.emit(researchRunId, 'cancelled', 'Research run stopped: cancelled mid-run.');
  }

  private async emit(
    researchRunId: string,
    type: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.researchRunEvent.create({
      data: { researchRunId, type, message, metadata: metadata as Prisma.InputJsonValue },
    });
  }

  /**
   * Idempotent persistence: any Sources already written for this run (from
   * a previous, interrupted attempt) are replaced wholesale rather than
   * appended to, so a retried job can never accumulate duplicates —
   * ENGINEERING-RULES.md §14 "Research should not create duplicate
   * sources/evidence simply because a job was retried."
   */
  private async persistSources(
    projectId: string,
    researchRunId: string,
    candidates: SourceCandidate[],
  ) {
    // A retried job's previous Sources get deleted below (cascading to
    // their SourceDocument rows — see schema.prisma), but the extracted
    // text in SourceDocumentText has no FK and isn't cascade-cleaned.
    // Gather the ids first so we can clean those up explicitly after.
    const staleSourceIds = (
      await this.prisma.source.findMany({ where: { researchRunId }, select: { id: true } })
    ).map((s) => s.id);

    const rows = candidates.map((candidate) => ({
      projectId,
      researchRunId,
      provider: mapProvider(candidate.provider),
      title: candidate.title,
      authors: (candidate.authors as Prisma.InputJsonValue) ?? undefined,
      publicationDate: candidate.publicationDate,
      publisher: candidate.publisher,
      journal: candidate.journal,
      url: candidate.url,
      doi: candidate.doi,
      sourceType: candidate.sourceType,
      abstract: candidate.abstract,
      language: candidate.language,
      metadata: (candidate.metadata as Prisma.InputJsonValue) ?? undefined,
      relevanceScore: candidate.relevanceScore,
      evaluationStatus: evaluate(candidate.relevanceScore),
    }));

    await this.prisma.$transaction([
      this.prisma.source.deleteMany({ where: { researchRunId } }),
      this.prisma.source.createMany({ data: rows }),
    ]);

    if (staleSourceIds.length) {
      await this.sourceDocuments.cleanupOrphanedText(staleSourceIds);
    }

    // createMany doesn't return the created rows (no RETURNING support in
    // Prisma for Postgres createMany), and extractEvidence needs the real
    // ids — so read back what was just written for this run.
    return this.prisma.source.findMany({ where: { researchRunId } });
  }

  /**
   * Full-text retrieval for ACCEPTED sources only — see the Slice 2
   * decisions doc's vertical chain. Sequential (not Promise.all) on
   * purpose: this fetches third-party URLs one at a time rather than
   * hammering several hosts concurrently from one worker. Returns each
   * source's outcome (not just aggregate counts) so extractEvidence
   * knows, per source, exactly what it's allowed to do with it — a
   * FAILED source must never reach the Evidence Analyst.
   */
  private async retrieveFullText(acceptedSources: Source[]): Promise<{
    outcomes: Map<string, SourceDocumentStatus>;
    attempted: number;
    completed: number;
    abstractOnly: number;
    failed: number;
  }> {
    const outcomes = new Map<string, SourceDocumentStatus>();
    let completed = 0;
    let abstractOnly = 0;
    let failed = 0;

    for (const source of acceptedSources) {
      const outcome = await this.sourceDocuments.retrieveForSource(source);
      outcomes.set(outcome.sourceId, outcome.status);
      if (outcome.status === SourceDocumentStatus.COMPLETED) completed++;
      else if (outcome.status === SourceDocumentStatus.ABSTRACT_ONLY) abstractOnly++;
      else failed++;
    }

    return { outcomes, attempted: acceptedSources.length, completed, abstractOnly, failed };
  }

  /**
   * Real AI evidence extraction via the Evidence Analyst role — replaces
   * the earlier abstract-slicing placeholder entirely. Per the locked
   * Slice 3 decisions:
   *  - COMPLETED sources feed the model their actual retrieved full text
   *    (extractionScope FULL_TEXT).
   *  - ABSTRACT_ONLY sources feed it only the stored abstract
   *    (extractionScope ABSTRACT_ONLY).
   *  - FAILED sources — or any ACCEPTED source with no retrieval outcome
   *    at all — are skipped outright. A failed retrieval must never
   *    become evidence merely because Source.abstract happens to be
   *    non-null (e.g. a web source's Tavily snippet); that field is
   *    discovery metadata, not usable material, once retrieval failed.
   * One source's AI failure (a Gemini error, a validation failure) is
   * logged and skipped, not fatal to the whole run — a transient
   * provider issue on one source shouldn't fail everything already
   * successfully retrieved.
   * Idempotent for the same reason persistSources is: replace, don't
   * accumulate, on retry.
   */
  private async extractEvidence(
    projectId: string,
    researchRunId: string,
    sources: Source[],
    documentOutcomes: Map<string, SourceDocumentStatus>,
    researchPlan: { mainQuestion: string | null; evidenceCategories: Prisma.JsonValue | null } | null,
  ): Promise<Evidence[]> {
    const researchQuestion = researchPlan?.mainQuestion ?? undefined;
    const evidenceCategories = Array.isArray(researchPlan?.evidenceCategories)
      ? (researchPlan!.evidenceCategories as unknown[]).filter(
          (c): c is string => typeof c === 'string',
        )
      : undefined;

    const rows: Prisma.EvidenceCreateManyInput[] = [];

    for (const source of sources) {
      if (source.evaluationStatus !== SourceEvaluationStatus.ACCEPTED) continue;

      const status = documentOutcomes.get(source.id);
      if (status !== SourceDocumentStatus.COMPLETED && status !== SourceDocumentStatus.ABSTRACT_ONLY) {
        continue; // FAILED, or no retrieval outcome recorded at all.
      }
      const extractionScope: ExtractionScope =
        status === SourceDocumentStatus.COMPLETED ? 'FULL_TEXT' : 'ABSTRACT_ONLY';

      const rawText =
        extractionScope === 'FULL_TEXT'
          ? await this.sourceDocuments.getStoredText(source.id)
          : source.abstract;
      if (!rawText || rawText.trim().length === 0) continue;

      const truncated = rawText.length > MAX_EVIDENCE_INPUT_CHARS;
      const text = truncated ? rawText.slice(0, MAX_EVIDENCE_INPUT_CHARS) : rawText;

      let items: EvidenceAnalystItem[];
      try {
        items = await this.aiGateway.analyzeEvidence({
          researchQuestion,
          evidenceCategories,
          sourceTitle: source.title,
          sourceType: source.sourceType,
          authors: extractAuthorNames(source.authors),
          publicationDate: source.publicationDate?.toISOString(),
          extractionScope,
          text: truncated
            ? `${text}\n\n[TRUNCATED — the source material continues beyond this point; this is not the end of the document.]`
            : text,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Evidence Analyst failed for source ${source.id}: ${message}`);
        continue;
      }

      for (const item of items) {
        rows.push({
          projectId,
          sourceId: source.id,
          researchRunId,
          type: item.type as EvidenceType,
          content: item.content,
          context: item.context,
          location: (item.location as Prisma.InputJsonValue) ?? undefined,
          confidence: item.confidence,
          limitations: combineLimitations(
            item.limitations,
            extractionScope === 'ABSTRACT_ONLY' ? ABSTRACT_ONLY_LIMITATION : undefined,
          ),
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.evidence.deleteMany({ where: { researchRunId } }),
      ...(rows.length ? [this.prisma.evidence.createMany({ data: rows })] : []),
    ]);

    // createMany doesn't return ids, and the Research Analyst step needs them to
    // ground its claim/conflict links — read back what was just written.
    return this.prisma.evidence.findMany({ where: { researchRunId } });
  }

  /**
   * Research Analyst role: turns this run's own Evidence into Claims
   * (with structured, id-grounded ClaimEvidence links), ResearchGaps, and
   * ResearchConflicts (with structured ConflictEvidence links) — the
   * CLAIMS -> CONFLICTS -> GAPS steps of the Research Intelligence
   * pipeline. Skipped when there's no evidence to reason over.
   *
   * Grounding is enforced twice: the role's prompt tells the model to
   * only reference evidence ids it was given, and this method
   * independently re-checks that against the real ids just extracted:
   *  - a claim's links are de-duplicated per evidence id (the join
   *    table's primary key is (claimId, evidenceId); a repeated id would
   *    otherwise crash the run) and filtered to known ids; a claim left
   *    with no valid link is dropped;
   *  - a conflict's ids are de-duplicated and filtered to known ids, and
   *    it is kept only if they span at least two DIFFERENT sources
   *    (RESEARCH-INTELLIGENCE.md: "when credible sources disagree") —
   *    two contradictory items from one source are not a conflict
   *    between sources.
   *
   * Every gap is persisted as LIMITED_EVIDENCE_FOUND, set here in code
   * rather than chosen by the model: this role only sees one run's
   * extracted evidence, so it cannot establish that "no research exists"
   * (which the docs say needs extremely strong evidence).
   *
   * The replace is atomic (one interactive transaction): a failure
   * partway leaves the previous Claims/Gaps/Conflicts intact rather than
   * a half-written set. Deleting Claims and Conflicts cascades their
   * ClaimEvidence/ConflictEvidence rows.
   */
  private async buildKnowledge(
    projectId: string,
    researchRunId: string,
    evidence: Evidence[],
    sourceTitleById: Map<string, string>,
    researchPlan: {
      mainQuestion: string | null;
      subQuestions: Prisma.JsonValue | null;
      evidenceCategories: Prisma.JsonValue | null;
    } | null,
  ): Promise<{ claimCount: number; gapCount: number; conflictCount: number; failed?: boolean }> {
    if (evidence.length === 0) {
      await this.prisma.$transaction([
        this.prisma.claim.deleteMany({ where: { researchRunId } }),
        this.prisma.researchGap.deleteMany({ where: { researchRunId } }),
        this.prisma.researchConflict.deleteMany({ where: { researchRunId } }),
      ]);
      return { claimCount: 0, gapCount: 0, conflictCount: 0 };
    }

    const sourceIdByEvidenceId = new Map(evidence.map((e) => [e.id, e.sourceId]));
    const researchQuestion = researchPlan?.mainQuestion ?? undefined;
    const subQuestions = Array.isArray(researchPlan?.subQuestions)
      ? (researchPlan!.subQuestions as unknown[]).filter((q): q is string => typeof q === 'string')
      : undefined;
    const evidenceCategories = Array.isArray(researchPlan?.evidenceCategories)
      ? (researchPlan!.evidenceCategories as unknown[]).filter(
          (c): c is string => typeof c === 'string',
        )
      : undefined;

    const evidenceRefs: ResearchAnalystEvidenceRef[] = evidence.map((e) => ({
      id: e.id,
      sourceTitle: sourceTitleById.get(e.sourceId) ?? 'Unknown source',
      type: e.type,
      content: e.content,
      context: e.context ?? undefined,
      limitations: e.limitations ?? undefined,
      confidence: e.confidence ?? 0.5,
    }));

    let analysis: ResearchAnalystOutput;
    try {
      analysis = await this.aiGateway.analyzeResearch({
        researchQuestion,
        subQuestions,
        evidenceCategories,
        evidence: evidenceRefs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Research Analyst failed for research run ${researchRunId}: ${message}`);
      // Same policy as a single source's Evidence Analyst failure: don't
      // fail the whole run over this step. Existing Claims/Gaps/Conflicts
      // for this run are left as they were from any prior attempt rather
      // than wiped, since we have nothing to replace them with. `failed`
      // makes this visible in the run's event log instead of masquerading
      // as a legitimate "0 claims" result.
      return { claimCount: 0, gapCount: 0, conflictCount: 0, failed: true };
    }

    const validClaims = analysis.claims
      .map((claim) => {
        const seen = new Set<string>();
        const evidenceLinks = claim.evidenceLinks.filter((link) => {
          if (!sourceIdByEvidenceId.has(link.evidenceId) || seen.has(link.evidenceId)) return false;
          seen.add(link.evidenceId);
          return true;
        });
        return { ...claim, evidenceLinks };
      })
      .filter((claim) => {
        if (claim.evidenceLinks.length > 0) return true;
        this.logger.warn(
          `Dropped a claim with no valid evidence links for run ${researchRunId}: "${claim.statement.slice(0, 100)}"`,
        );
        return false;
      });

    // Second-pass check: a real evidenceId proves nothing about whether
    // the claim's own WORDING stays within what that evidence's content
    // actually says (see claim-grounding-check.role.ts — a live run
    // surfaced exactly this: a real, relevant evidence link, but the
    // claim asserted an effect the evidence never stated). Skipped only
    // when there's nothing left to check.
    const evidenceContentById = new Map(evidence.map((e) => [e.id, e.content]));
    const groundedClaims = await this.checkClaimGrounding(validClaims, evidenceContentById, researchRunId);

    const validConflicts = analysis.researchConflicts
      .map((conflict) => ({
        ...conflict,
        evidenceIds: Array.from(new Set(conflict.evidenceIds)).filter((id) =>
          sourceIdByEvidenceId.has(id),
        ),
      }))
      .filter((conflict) => {
        const distinctSources = new Set(conflict.evidenceIds.map((id) => sourceIdByEvidenceId.get(id)));
        if (conflict.evidenceIds.length >= 2 && distinctSources.size >= 2) return true;
        this.logger.warn(
          `Dropped a conflict that does not span 2+ distinct valid evidence items from 2+ sources for run ${researchRunId}: "${conflict.description.slice(0, 100)}"`,
        );
        return false;
      });

    await this.prisma.$transaction(async (tx) => {
      await tx.claim.deleteMany({ where: { researchRunId } });
      await tx.researchGap.deleteMany({ where: { researchRunId } });
      await tx.researchConflict.deleteMany({ where: { researchRunId } });

      for (const claim of groundedClaims) {
        await tx.claim.create({
          data: {
            projectId,
            researchRunId,
            statement: claim.statement,
            claimType: claim.claimType,
            status: claim.status as ClaimStatus,
            confidence: claim.confidence,
            evidence: {
              createMany: {
                data: claim.evidenceLinks.map((link) => ({
                  evidenceId: link.evidenceId,
                  relationship: link.relationship as ClaimEvidenceRelationship,
                })),
              },
            },
          },
        });
      }

      if (analysis.researchGaps.length) {
        await tx.researchGap.createMany({
          data: analysis.researchGaps.map((gap) => ({
            projectId,
            researchRunId,
            type: LIMITED_EVIDENCE_GAP_TYPE,
            description: gap.description,
            scope: gap.scope,
            evidence: gap.evidenceNote,
            confidence: gap.confidence,
          })),
        });
      }

      for (const conflict of validConflicts) {
        await tx.researchConflict.create({
          data: {
            projectId,
            researchRunId,
            description: conflict.description,
            context: conflict.context,
            resolutionStatus: 'UNRESOLVED',
            evidence: {
              createMany: {
                data: conflict.evidenceIds.map((evidenceId) => ({ evidenceId })),
              },
            },
          },
        });
      }
    });

    return {
      claimCount: groundedClaims.length,
      gapCount: analysis.researchGaps.length,
      conflictCount: validConflicts.length,
    };
  }

  /**
   * Runs the second-pass wording check (see claim-grounding-check.role.ts)
   * over claims that already passed the structural id-check, and returns
   * only the ones it actually confirmed. Fails CLOSED: if the check
   * itself errors (network, AI Gateway failure, bad shape), every claim
   * for this run is dropped rather than persisted unverified — the whole
   * point of this step is that an id-valid claim isn't trustworthy on its
   * own, so a failure to check is treated the same as a failed check, not
   * as permission to skip it. Also fails closed per-claim: any claim id
   * the model didn't return, or returned with grounded !== true, is
   * dropped, not assumed grounded by default.
   */
  private async checkClaimGrounding(
    claims: ResearchAnalystClaim[],
    evidenceContentById: Map<string, string>,
    researchRunId: string,
  ): Promise<ResearchAnalystClaim[]> {
    if (claims.length === 0) return [];

    const input: ClaimGroundingCheckClaimInput[] = claims.map((claim, index) => ({
      id: `c${index}`,
      statement: claim.statement,
      linkedEvidence: claim.evidenceLinks.map((link) => ({
        id: link.evidenceId,
        content: evidenceContentById.get(link.evidenceId) ?? '',
      })),
    }));

    let groundedIds: Set<string>;
    try {
      const { results } = await this.aiGateway.checkClaimGrounding({ claims: input });
      groundedIds = new Set(results.filter((r) => r.grounded).map((r) => r.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Claim grounding check failed for research run ${researchRunId}; dropping all ${claims.length} proposed claim(s) rather than persist them unverified: ${message}`,
      );
      return [];
    }

    return claims.filter((claim, index) => {
      const id = `c${index}`;
      if (groundedIds.has(id)) return true;
      this.logger.warn(
        `Dropped a claim that failed the grounding check for run ${researchRunId}: "${claim.statement.slice(0, 100)}"`,
      );
      return false;
    });
  }
}

function combineLimitations(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  return kept.length ? kept.join(' ') : undefined;
}

function extractAuthorNames(authors: Prisma.JsonValue | null): string[] | undefined {
  if (!Array.isArray(authors)) return undefined;
  const names = authors
    .map((a) =>
      a && typeof a === 'object' && !Array.isArray(a) && typeof (a as Record<string, unknown>).name === 'string'
        ? ((a as Record<string, unknown>).name as string)
        : undefined,
    )
    .filter((name): name is string => Boolean(name));
  return names.length ? names : undefined;
}

function mapProvider(provider: SourceCandidate['provider']): SourceProvider {
  return provider === 'tavily' ? SourceProvider.TAVILY : SourceProvider.SEMANTIC_SCHOLAR;
}

function evaluate(relevanceScore: number | undefined): SourceEvaluationStatus {
  if (relevanceScore === undefined) return SourceEvaluationStatus.NEEDS_REVIEW;
  return relevanceScore >= AUTO_ACCEPT_THRESHOLD
    ? SourceEvaluationStatus.ACCEPTED
    : SourceEvaluationStatus.NEEDS_REVIEW;
}

function buildDiscoveryQuery(plan: {
  mainQuestion: string | null;
  keywords: Prisma.JsonValue | null;
  geographicConstraints: Prisma.JsonValue | null;
}) {
  const keywords = Array.isArray(plan.keywords)
    ? (plan.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  const geographicFocus =
    plan.geographicConstraints &&
    typeof plan.geographicConstraints === 'object' &&
    plan.geographicConstraints !== null &&
    'region' in plan.geographicConstraints
      ? String((plan.geographicConstraints as Record<string, unknown>).region)
      : undefined;

  return {
    query: plan.mainQuestion ?? keywords.join(' ') ?? '',
    keywords,
    geographicFocus,
    maxResults: 10,
  };
}