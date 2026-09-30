import { Module } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';
import { GeminiProvider } from './providers/gemini.provider';

@Module({
  providers: [AiGatewayService, GeminiProvider],
  exports: [AiGatewayService],
})
export class AiModule {}