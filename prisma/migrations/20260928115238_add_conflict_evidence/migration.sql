-- CreateTable
CREATE TABLE "ConflictEvidence" (
    "conflictId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConflictEvidence_pkey" PRIMARY KEY ("conflictId","evidenceId")
);

-- AddForeignKey
ALTER TABLE "ConflictEvidence" ADD CONSTRAINT "ConflictEvidence_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "ResearchConflict"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictEvidence" ADD CONSTRAINT "ConflictEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
