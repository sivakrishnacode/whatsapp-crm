'use client';

import { Bell, BellOff, Play, Volume2, VolumeX } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useMessageAlerts } from '@/hooks/use-message-alerts';

/**
 * Sound / desktop-alert controls, and the thing that actually mounts the
 * alert subscription for the whole app.
 *
 * It lives in the header rather than in Settings for two reasons: the
 * permission prompt has to fire from a user gesture, and "turn that noise
 * off" needs to be reachable in one click from wherever the user is when
 * the noise happens.
 */
export function AlertSettingsMenu() {
  const { sound, desktop, permission, setSound, setDesktop, preview } =
    useMessageAlerts();

  const blocked = permission === 'denied';
  const Icon = sound ? Volume2 : VolumeX;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Message alert settings"
        title={sound ? 'Alert sound is on' : 'Alert sound is off'}
        className={cn(
          'flex size-9 items-center justify-center rounded-md transition-colors',
          sound
            ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
            : 'text-muted-foreground/60 hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onClick={() => setSound(!sound)}>
          {sound ? (
            <VolumeX className="size-4" />
          ) : (
            <Volume2 className="size-4" />
          )}
          {sound ? 'Mute new-message sound' : 'Unmute new-message sound'}
        </DropdownMenuItem>

        <DropdownMenuItem onClick={preview} disabled={!sound}>
          <Play className="size-4" />
          Play test sound
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => void setDesktop(!desktop)}
          disabled={blocked}
        >
          {desktop ? <BellOff className="size-4" /> : <Bell className="size-4" />}
          {desktop ? 'Turn off desktop alerts' : 'Turn on desktop alerts'}
        </DropdownMenuItem>

        <p className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {blocked
            ? 'Your browser has blocked notifications for this site — re-enable them in the site permissions to use desktop alerts.'
            : 'The sound plays while this tab is open, even in the background or behind another app. Desktop alerts add a popup when the tab is not visible. Neither works once the browser is fully closed.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
