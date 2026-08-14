import { Module } from '@nestjs/common';
import { ConnectionsController } from './controllers/connections.controller';
import { ConnectionsOAuthController } from './controllers/connections-oauth.controller';
import { ConnectionService } from './services/connection.service';
import { ConnectionTokenService } from './services/connection-token.service';
import { OAuthFlowService } from './services/oauth-flow.service';
import { ConnectorRegistryService } from './services/connector-registry.service';
import { ConnectorExecutionService } from './services/connector-execution.service';

/**
 * OAuth connections to third-party apps, and the connector catalogue
 * that turns them into automation steps.
 *
 * Design and the decisions behind it: docs/app-connections.md.
 *
 * WHAT THIS OWNS
 *   `app_connections` (migration 082), the OAuth redirect flow, token
 *   refresh, and one connector file per app. Google Sheets, Gmail,
 *   Calendar and Meet are four apps sharing ONE Google connection,
 *   because Google issues one refresh token per (client, user) however
 *   many product scopes it covers.
 *
 * WHY IT IS NOT PART OF IntegrationsModule
 *   That module is Zapier: outbound webhooks the user pastes a URL for,
 *   with no stored credential. This one stores durable credentials for
 *   somebody's mailbox and calendar. Different security posture,
 *   different lifecycle, different module.
 *
 * ⚠️ THE TWO RULES THAT MATTER MOST HERE
 *   1. ConnectionTokenService is the ONLY place a token is decrypted,
 *      and no token may reach a queue payload, an API response or a log
 *      line. Redis stores job data in plaintext and Bull Board renders it.
 *   2. Every scope in the catalogue is SENSITIVE, never RESTRICTED.
 *      A restricted scope (gmail.compose, gmail.readonly, drive) would
 *      commit the product to an annual paid CASA security assessment.
 *      That is why Gmail is send-only and why nothing lists Drive files.
 */
@Module({
  controllers: [ConnectionsController, ConnectionsOAuthController],
  providers: [
    ConnectionService,
    ConnectionTokenService,
    OAuthFlowService,
    ConnectorRegistryService,
    ConnectorExecutionService,
  ],
  // AutomationsModule needs these two for the `app_action` step: the
  // registry to validate app/action, the executor to run it.
  exports: [ConnectorRegistryService, ConnectorExecutionService],
})
export class ConnectionsModule {}
