import { Module, forwardRef } from '@nestjs/common';

import { FormsService } from './services/forms.service';
import { FormSubmitService } from './services/form-submit.service';
import { FormContactResolverService } from './services/form-contact-resolver.service';
import { BookingService } from './services/booking.service';
import { BookingCalendarService } from './services/booking-calendar.service';

// forwardRef on both, and it is load-bearing.
//
// The "no reverse import, so no cycle" reasoning held only while nothing
// imported FormsModule back. WebModule now does — the widget resolves and
// submits pre-chat, offline and inline-card forms through FormsService — and
// WebModule sits inside the existing channel cycle
// (Automations -> Whatsapp -> V1 -> Instagram -> Messaging -> Web). So
// FormsModule is now reachable from AutomationsModule, which makes its own
// import of AutomationsModule a genuine cycle: Nest hands it `undefined` at
// scan time and boot fails with "the module at index [0] is undefined".
//
// Not caught by typecheck or by unit tests — only by actually booting the
// container, which is why that check is worth running after touching module
// wiring.
import { AutomationsModule } from '../automations/automations.module';
import { V1Module } from '../v1/v1.module';
// No forwardRef: ConnectionsModule imports nothing at all, so it cannot
// reach back here and cannot be part of a cycle. Booking forms use it for
// Google Calendar availability and Meet links (migration 085).
import { ConnectionsModule } from '../connections/connections.module';
import { FormsController } from './forms.controller';
import { FormsPublicController } from './forms-public.controller';
import {
  BookingsController,
  BookingsPublicController,
} from './bookings.controller';

@Module({
  imports: [
    forwardRef(() => AutomationsModule),
    forwardRef(() => V1Module),
    ConnectionsModule,
  ],
  controllers: [
    FormsController,
    FormsPublicController,
    BookingsController,
    BookingsPublicController,
  ],
  providers: [
    FormsService,
    FormSubmitService,
    FormContactResolverService,
    BookingService,
    BookingCalendarService,
  ],
  exports: [FormsService, FormSubmitService, BookingService],
})
export class FormsModule {}
