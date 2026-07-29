import { IsString, MaxLength } from 'class-validator';

export class UploadWebMediaDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MaxLength(128)
  content_type!: string;

  /**
   * Base64 payload.
   *
   * The cap is ~28 MB of base64, which decodes to just over the service's
   * 20 MB byte limit. Sized deliberately above it so an oversized upload is
   * rejected by `WebMediaService` with a message naming the real MB limit,
   * rather than by this validator complaining about a base64 string length
   * no user can reason about.
   */
  @IsString()
  @MaxLength(29_000_000)
  data_base64!: string;
}
