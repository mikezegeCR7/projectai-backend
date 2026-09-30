import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';

// SessionAuthGuard is provided/exported here (not just AuthService) because
// @UseGuards(SessionAuthGuard) needs Nest to resolve the guard's own
// constructor dependencies from *some* module — any module that protects
// routes with it must import AuthModule.
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
