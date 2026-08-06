import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';

/**
 * DTOs for the Ads Manager connect flow.
 *
 * Note what is NOT here: nothing takes an access token, and nothing
 * takes an ad account, page or pixel id that is then used without being
 * checked back against Meta or against the stored connection. Ids
 * arriving here are *selections from a list we produced*, and the
 * services re-resolve them — see the note at the top of
 * services/ads-config.service.ts for why that distinction matters on a
 * surface that spends money.
 *
 * Meta object ids are numeric strings (a page id, an ad account id) or
 * our own `sandbox_`-prefixed fixtures. The pattern bounds them so a
 * hostile value cannot reach a Graph path — Graph would reject it, but
 * an id is concatenated into a URL and should never be free text.
 */

const META_ID = /^[A-Za-z0-9_]+$/;
const META_ID_MESSAGE =
  'must be a Meta object id (letters, digits and underscores only)';

export class SelectAdAccountDto {
  /** With or without the `act_` prefix; normalised server-side. */
  @IsString()
  @MaxLength(64)
  @Matches(/^(act_)?[A-Za-z0-9_]+$/, {
    message: `adAccountId ${META_ID_MESSAGE}`,
  })
  adAccountId!: string;

  /**
   * Narrows the lookup to one business portfolio. Safe to accept: it
   * only filters a list Meta already scopes to the connected user's own
   * permissions.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(META_ID, { message: `businessId ${META_ID_MESSAGE}` })
  businessId?: string;
}

export class SelectPageDto {
  @IsString()
  @MaxLength(64)
  @Matches(META_ID, { message: `pageId ${META_ID_MESSAGE}` })
  pageId!: string;
}

export class SelectPixelDto {
  /**
   * `null` clears the selection — a website ad optimising for traffic
   * rather than conversions needs no pixel, and the user must be able to
   * go back to that.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(META_ID, { message: `pixelId ${META_ID_MESSAGE}` })
  pixelId?: string | null;
}

export class ListAdAccountsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(META_ID, { message: `businessId ${META_ID_MESSAGE}` })
  businessId?: string;
}

export class StartOAuthQueryDto {
  /**
   * Where to send the browser after the callback.
   *
   * Constrained to a fixed set rather than accepting a path: this value
   * survives a round trip through facebook.com and comes back on a GET,
   * which makes a free-form redirect target an open-redirect primitive.
   * The web app only ever needs these two.
   */
  @IsOptional()
  @IsIn(['setup', 'create'])
  returnTo?: 'setup' | 'create';
}
