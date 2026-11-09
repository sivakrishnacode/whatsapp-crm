import 'server-only';

import { cache } from 'react';

/**
 * The request's clock for Server Components.
 *
 * Memoised per render pass, so every component in one page agrees on what
 * "now" is — an SLA badge and the "evaluated at" line beside it can never
 * straddle a minute boundary. It also keeps the impure `Date.now()` out of
 * component bodies, which React's purity rule rightly flags.
 */
export const requestNow = cache((): Date => new Date());
