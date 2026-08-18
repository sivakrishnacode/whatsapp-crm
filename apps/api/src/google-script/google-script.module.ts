import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { GoogleScriptController } from './controllers/google-script.controller';
import { GoogleScriptConnectionService } from './services/google-script-connection.service';
import { GoogleScriptExecutorService } from './services/google-script-executor.service';

/**
 * The Google integration: Gmail, Calendar, Meet and Sheets through one
 * Apps Script bridge the customer deploys in their own account.
 *
 * Replaces the OAuth `ConnectionsModule` (migration 082, removed in 092).
 *
 * Imports nothing but Prisma, so — like the module it replaces — it cannot
 * be part of a dependency cycle and consumers (AutomationsModule) need no
 * `forwardRef`. Module wiring is not caught by typecheck; boot the
 * container after changing it.
 */
@Module({
  imports: [PrismaModule],
  controllers: [GoogleScriptController],
  providers: [GoogleScriptConnectionService, GoogleScriptExecutorService],
  exports: [GoogleScriptConnectionService, GoogleScriptExecutorService],
})
export class GoogleScriptModule {}
