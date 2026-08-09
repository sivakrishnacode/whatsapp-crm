import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EntitlementService } from './services/entitlement.service';
import { EntitlementGuard } from './guards/entitlement.guard';

/**
 * Entitlement is cross-cutting, so it is `@Global()` — the same call
 * PrismaModule makes, for the same reason.
 *
 * `@RequiresEntitlement()` applies `EntitlementGuard` by class reference,
 * and Nest resolves a route-level guard from the module context of the
 * controller that declares it. Without a global provider, every module
 * with a gated route (whatsapp, v1, flows, account, instagram, web,
 * ecommerce…) would have to import this one — and the failure mode of
 * forgetting is a DI error at boot rather than a missing check, but it is
 * still eight imports that exist only to satisfy the container.
 *
 * Kept separate from SubscriptionModule on purpose: that module owns
 * controllers, webhooks and the Razorpay/Stripe clients, and a gate on a
 * send route should not pull payment gateways into its dependency graph.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [EntitlementService, EntitlementGuard],
  exports: [EntitlementService, EntitlementGuard],
})
export class EntitlementModule {}
