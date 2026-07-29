import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendWebMessageDto {
  /**
   * 4000 chars. Generous for a chat message and bounded because this is a
   * public endpoint — an unbounded text column reachable by anonymous
   * callers is a storage-exhaustion vector, not just a UI problem.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @IsOptional()
  @IsIn(['text', 'image', 'video', 'audio', 'document'])
  content_type?: 'text' | 'image' | 'video' | 'audio' | 'document';

  /**
   * Must be a URL our own upload endpoint returned. Not re-validated as
   * an arbitrary URL here: accepting a visitor-chosen remote URL would
   * make the inbox render third-party content and hand an attacker an
   * SSRF-adjacent surface if anything ever fetches it server-side.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  media_url?: string;

  /** The `reply_id` of a button or list row the visitor tapped. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reply_id?: string;

  /** Which page the visitor was on — shown to the agent in the inbox. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  page_url?: string;

  /**
   * Read by `VisitorSessionGuard` for callers that cannot set an
   * `Authorization` header. Guards run before pipes in Nest, so the guard
   * sees the raw body and this declaration does not gate it — the fields
   * are declared so the wire contract lives in one place, and so
   * `whitelist: true` does not strip them from a body a handler may later
   * want to read.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  session_token?: string;

  /** Same as `session_token`, for `WidgetKeyGuard`. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  widget_key?: string;
}
