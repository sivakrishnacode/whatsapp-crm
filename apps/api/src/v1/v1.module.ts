import { Module, forwardRef } from '@nestjs/common';
import { InstagramModule } from '../instagram/instagram.module';
import { QueueModule } from '../queue/queue.module';
import { WebhookDeliveryProcessor } from './queues/webhook-delivery.processor';
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
  imports: [
    // POST /v1/messages routes Instagram conversations to
    // InstagramSendService. forwardRef because InstagramModule imports
    // this one back for its webhook fan-out.
    forwardRef(() => InstagramModule),
    // Broadcasts are enqueued, not delivered here; webhook events are
    // delivered by this module's own processor.
    QueueModule,
  ],
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
    WebhookDeliveryProcessor,
    MessageSendService,
    BroadcastSendService,
  ],
  exports: [WebhookDeliverService, MessageSendService, BroadcastSendService],
})
export class V1Module {}
