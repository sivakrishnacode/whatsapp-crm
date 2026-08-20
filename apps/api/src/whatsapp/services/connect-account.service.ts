import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  verifyPhoneNumber,
  registerPhoneNumber,
  subscribeWabaToApp,
  isPhoneRegistered,
  type MetaPhoneInfo,
} from '../meta-api.util';
import { encrypt } from '../../common/security/encryption.util';

export interface SaveWhatsAppConnectionArgs {
  accountId: string;
  userId: string;
  phoneNumberId: string;
  wabaId: string | null;
  /** Plaintext access token — encrypted here before it touches the DB. */
  accessToken: string;
  verifyToken?: string | null;
  /**
   * 6-digit 2-step-verification PIN for POST /register. Omitted/null
   * skips registration.
   */
  pin?: string | null;
  /**
   * True for Embedded Signup "coexistence" connections — the merchant
   * kept their number on the WhatsApp Business App.
   */
  skipRegistration?: boolean;
  businessId?: string | null;
  connectionMethod?: 'manual' | 'embedded_signup';
  tokenExpiresAt?: string | null;
  /**
   * Meta Commerce catalog id linked to this WABA. Required to send product /
   * product-list messages. `undefined` leaves any existing value untouched;
   * an empty string clears it.
   */
  catalogId?: string | null;
}

export type SaveWhatsAppConnectionResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      registered: boolean;
      registration_error: string | null;
      registration_skipped: boolean;
      phone_info: MetaPhoneInfo;
    };

@Injectable()
export class ConnectAccountService {
  private readonly logger = new Logger(ConnectAccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verify, register, subscribe, and persist a WhatsApp connection into `whatsapp_config`.
   * Shared by the manual-entry and the Embedded Signup routes.
   */
  async saveWhatsAppConnection(
    args: SaveWhatsAppConnectionArgs,
  ): Promise<SaveWhatsAppConnectionResult> {
    const {
      accountId,
      userId,
      phoneNumberId,
      wabaId,
      accessToken,
      verifyToken,
      pin,
      skipRegistration,
      businessId,
      connectionMethod = 'manual',
      tokenExpiresAt,
      catalogId,
    } = args;

    try {
      // Reject if another account has already claimed this phone_number_id.
      const claimed = await this.prisma.whatsapp_config.findFirst({
        where: {
          phone_number_id: phoneNumberId,
          NOT: {
            account_id: accountId,
          },
        },
        select: {
          account_id: true,
        },
      });

      if (claimed) {
        return {
          ok: false,
          status: HttpStatus.CONFLICT,
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one Converse360 user.',
        };
      }

      // Verify credentials with Meta BEFORE saving.
      let phoneInfo: MetaPhoneInfo;
      try {
        phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown Meta API error';
        this.logger.error(
          `Meta API verification failed during save: ${message}`,
        );
        return {
          ok: false,
          status: HttpStatus.BAD_REQUEST,
          error: `Meta API error: ${message}`,
        };
      }

      // Encrypt sensitive tokens before storing.
      let encryptedAccessToken: string;
      let encryptedVerifyToken: string | null;
      try {
        encryptedAccessToken = encrypt(accessToken);
        encryptedVerifyToken = verifyToken ? encrypt(verifyToken) : null;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown encryption error';
        this.logger.error(`Encryption failed: ${message}`);
        return {
          ok: false,
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        };
      }

      // Look up any pre-existing row for this account so we know whether
      // this number is already registered with Meta.
      const existing = await this.prisma.whatsapp_config.findUnique({
        where: { account_id: accountId },
        select: {
          id: true,
          registered_at: true,
          phone_number_id: true,
        },
      });

      const sameNumber =
        existing?.phone_number_id === phoneNumberId &&
        existing?.registered_at != null;

      // Meta's own verdict, from the metadata we just fetched. This
      // outranks anything we have stored: `registered_at` records what
      // we last managed to do, which is a different question.
      const registeredAtMeta = isPhoneRegistered(phoneInfo);

      // Step 1: register the phone number for inbound webhooks.
      let registeredAt: Date | null = existing?.registered_at ?? null;
      let registrationError: string | null = null;
      let registrationSkipped = false;

      if (skipRegistration) {
        // Coexistence — Meta forbids re-registering a number the WhatsApp
        // Business App already owns.
        registrationSkipped = true;
      } else if (registeredAtMeta) {
        // Already registered on Meta's side, so /register has nothing to
        // do — and doing it anyway is actively harmful. Once two-step
        // verification is set (`is_pin_enabled`), re-registering with any
        // PIN but the original one fails with "(#133005) Two step
        // verification PIN Mismatch". That failure used to be treated as
        // "not registered" and wiped a perfectly live connection.
        registrationSkipped = true;
        registeredAt = registeredAt ?? new Date();
      } else {
        const needsRegistration =
          !sameNumber || (typeof pin === 'string' && pin.length > 0);
        if (needsRegistration) {
          if (!pin) {
            registrationSkipped = true;
          } else {
            try {
              await registerPhoneNumber({ phoneNumberId, accessToken, pin });
              registeredAt = new Date();
            } catch (err) {
              registrationError =
                err instanceof Error ? err.message : 'Unknown Meta API error';
              this.logger.error(
                `Phone number /register failed: ${registrationError}`,
              );
            }
          }
        }
      }

      // Step 2: subscribe the WABA to this app.
      let subscribedAppsAt: Date | null = null;
      if (wabaId) {
        try {
          await subscribeWabaToApp({ wabaId, accessToken });
          subscribedAppsAt = new Date();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `WABA subscribed_apps failed (non-fatal): ${message}`,
          );
        }
      }

      // A registration failure only means "not connected" when Meta also
      // says the number is not registered. Otherwise the connection is
      // live and the failed call was redundant — writing `disconnected`
      // there produced a banner announcing an outage that wasn't
      // happening, on a number that was receiving messages at the time.
      const liveAtMeta = registeredAtMeta || !registrationError;

      const baseRow = {
        phone_number_id: phoneNumberId,
        waba_id: wabaId || null,
        access_token: encryptedAccessToken,
        verify_token: encryptedVerifyToken,
        status: liveAtMeta ? 'connected' : 'disconnected',
        connected_at: liveAtMeta ? new Date() : null,
        registered_at: liveAtMeta ? registeredAt : null,
        subscribed_apps_at: subscribedAppsAt ?? null,
        last_registration_error: registrationError,
        connection_method: connectionMethod,
        business_id: businessId || null,
        coexistence: Boolean(skipRegistration),
        token_expires_at: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
        updated_at: new Date(),
        // Only touch catalog_id when the caller supplied one, so re-saving the
        // connection form (which omits it) never wipes a configured catalog.
        ...(catalogId !== undefined ? { catalog_id: catalogId || null } : {}),
      };

      if (existing) {
        await this.prisma.whatsapp_config.update({
          where: { account_id: accountId },
          data: baseRow,
        });
      } else {
        await this.prisma.whatsapp_config.create({
          data: {
            account_id: accountId,
            user_id: userId,
            ...baseRow,
          },
        });
      }

      return {
        ok: true,
        registered: registeredAt != null,
        registration_error: registrationError,
        registration_skipped: registrationSkipped,
        phone_info: phoneInfo,
      };
    } catch (err) {
      this.logger.error(`saveWhatsAppConnection failed:`, err);
      return {
        ok: false,
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error:
          err instanceof Error ? err.message : 'Failed to save configuration',
      };
    }
  }
}
