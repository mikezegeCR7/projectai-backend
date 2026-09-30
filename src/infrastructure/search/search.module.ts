import { Module } from '@nestjs/common';
import { SearchGatewayService } from './search-gateway.service';
import { TavilySearchProvider } from './providers/tavily.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';

@Module({
  providers: [SearchGatewayService, TavilySearchProvider, SemanticScholarProvider],
  exports: [SearchGatewayService],
})
export class SearchModule {}
