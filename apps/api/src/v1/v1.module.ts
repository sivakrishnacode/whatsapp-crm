import { Module } from '@nestjs/common';
import { MeController } from './controllers/me.controller';
import { ContactsController } from './controllers/contacts.controller';
import { ConversationsController } from './controllers/conversations.controller';
import { MessagesController } from './controllers/messages.controller';
import { BroadcastsController } from './controllers/broadcasts.controller';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookDeliverService } from './services/webhook-deliver.service';
import { MessageSendService } from './services/message-send.service';
import { BroadcastSendService } from './services/broadcast-send.service';

@Module({
  controllers: [
    MeController,
    ContactsController,
    ConversationsController,
    MessagesController,
    BroadcastsController,
    WebhooksController,
  ],
  providers: [
    WebhookDeliverService,
    MessageSendService,
    BroadcastSendService,
  ],
  exports: [
    WebhookDeliverService,
    MessageSendService,
    BroadcastSendService,
  ],
})
export class V1Module {}
