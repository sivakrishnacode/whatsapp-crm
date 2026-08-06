import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

import { adsEnabled } from '../ads.config';

/**
 * Gates the whole Ads Manager surface on `ADS_MANAGER_ENABLED`.
 *
 * Applied on the controllers, not only in the web app's nav — a hidden
 * rail row is not access control, and these routes can spend money.
 *
 * Throws 404 rather than 403 deliberately. A 403 confirms the endpoint
 * exists and is merely switched off, which is an invitation to keep
 * probing; while the feature is unreleased the honest answer is "there
 * is nothing here".
 */
@Injectable()
export class AdsEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!adsEnabled()) throw new NotFoundException();
    return true;
  }
}
