import { Module } from '@nestjs/common';
import { AccountController } from './controllers/account.controller';
import { AccountMembersController } from './controllers/account-members.controller';
import { AccountInvitationsController } from './controllers/account-invitations.controller';
import { AccountApiKeysController } from './controllers/account-api-keys.controller';
import { InvitationsPublicController } from './controllers/invitations-public.controller';

@Module({
  controllers: [
    AccountController,
    AccountMembersController,
    AccountInvitationsController,
    AccountApiKeysController,
    InvitationsPublicController,
  ],
})
export class AccountModule {}
