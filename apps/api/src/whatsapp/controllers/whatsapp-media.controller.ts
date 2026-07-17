import {
  Controller,
  Get,
  Param,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { getMediaUrl, downloadMedia } from '../meta-api.util';
import { decrypt } from '../../common/security/encryption.util';

/**
 * GET /api/whatsapp/media/:mediaId
 *
 * Secure media pass-through proxy. Resolves Meta's short-lived CDN URL
 * and streams the binary content without local disk storage.
 *
 * Meta CDN URLs expire ~5 min — the URL is re-resolved on every request.
 */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappMediaController {
  private readonly logger = new Logger(WhatsappMediaController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('media/:mediaId')
  async getMedia(
    @Param('mediaId') mediaId: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    if (!mediaId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Media ID is required' });
    }

    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
    });

    if (!config) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'WhatsApp not configured' });
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token!);
    } catch {
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to decrypt access token' });
    }

    try {
      const mediaInfo = await getMediaUrl({ mediaId, accessToken });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: mediaInfo.url,
        accessToken,
      });

      res.set({
        'Content-Type':
          contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      });
      return res.status(HttpStatus.OK).send(Buffer.from(buffer));
    } catch (err) {
      this.logger.error(
        `Media proxy failed for ${mediaId}: ${err instanceof Error ? err.message : err}`,
      );
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to fetch media' });
    }
  }
}
