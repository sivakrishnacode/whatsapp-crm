import { Module } from '@nestjs/common';
import { AccountController } from './controllers/account.controller';
import { AccountMembersController } from './controllers/account-members.controller';
import { AccountInvitationsController } from './controllers/account-invitations.controller';
import { AccountApiKeysController } from './controllers/account-api-keys.controller';
import { InvitationsPublicController } from './controllers/invitations-public.controller';
import { WorkspacesController } from './controllers/workspaces.controller';

@Module({
  controllers: [
    // Before AccountController: Nest matches in registration order, and
    // `@Controller('account')` there declares `@Get('members')`-style
    // sub-paths — a future `@Get(':something')` on it would otherwise
    // swallow `account/workspaces`.
    WorkspacesController,
    AccountController,
    AccountMembersController,
    AccountInvitationsController,
    AccountApiKeysController,
    InvitationsPublicController,
  ],
})
export class AccountModule {}
