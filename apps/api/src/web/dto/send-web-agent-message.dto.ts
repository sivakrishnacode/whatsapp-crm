import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class WebAgentButtonDto {
  @IsString()
  @MaxLength(200)
  id!: string;

  @IsString()
  @MaxLength(80)
  title!: string;
}

export class SendWebAgentMessageDto {
  @IsUUID()
  conversation_id!: string;

  @IsOptional()
  @IsIn(['text', 'image', 'video', 'audio', 'document', 'buttons'])
  message_type?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'buttons';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content_text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  media_url?: string;

  /**
   * No 3-button cap, unlike WhatsApp. That limit is Meta's UI, not ours —
   * the widget renders however many the agent sends. Capped at 10 anyway,
   * because a chat bubble with 30 buttons is a worse experience than a
   * list and there is a list type for that.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WebAgentButtonDto)
  buttons?: WebAgentButtonDto[];
}
