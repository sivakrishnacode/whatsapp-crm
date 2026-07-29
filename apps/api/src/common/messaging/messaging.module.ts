import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { InstagramModule } from '../../instagram/instagram.module';
import { WebModule } from '../../web/web.module';
import { ChannelSenderService } from './channel-sender.service';

/**
 * The channel-routing seam.
 *
 * Sits between the engines (AI reply, flows, automations) and the two
 * platform senders, so an engine never needs to know which platform a
 * conversation lives on.
 *
 * EVERY IMPORT HERE IS A forwardRef, AND HAS TO BE
 *   WhatsappModule and InstagramModule both import the engine modules
 *   (their webhooks dispatch into flows/automations/AI), and the engine
 *   modules import this one. That is a genuine cycle in the dependency
 *   graph — not an accident to be refactored away, but the shape of
 *   "webhook drives engine, engine sends via channel". Nest resolves it
 *   as long as both directions declare forwardRef.
 */
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule),
    forwardRef(() => InstagramModule),
    forwardRef(() => WebModule),
  ],
  providers: [ChannelSenderService],
  exports: [ChannelSenderService],
})
export class MessagingModule {}
