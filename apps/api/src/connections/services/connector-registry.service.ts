import { Injectable, BadRequestException } from '@nestjs/common';
import type {
  CatalogApp,
  Connector,
  ConnectorAction,
} from '../connections.types';
import { googleSheetsConnector } from '../connectors/google/google-sheets.connector';
import { gmailConnector } from '../connectors/google/gmail.connector';
import { googleCalendarConnector } from '../connectors/google/google-calendar.connector';
import { googleMeetConnector } from '../connectors/google/google-meet.connector';

/**
 * Every connector the product knows about, in picker order.
 *
 * ADDING AN APP IS ONE IMPORT AND ONE ARRAY ENTRY. That is the whole
 * point of the registry — the same shape as `src/ads/services/ad-types/`
 * and `ai/lib/skills.ts`. Nothing switches on an app id anywhere else.
 */
const CONNECTORS: Connector[] = [
  googleSheetsConnector,
  gmailConnector,
  googleCalendarConnector,
  googleMeetConnector,
];

@Injectable()
export class ConnectorRegistryService {
  private readonly byApp = new Map<string, Connector>(
    CONNECTORS.map((c) => [c.app, c]),
  );

  all(): Connector[] {
    return CONNECTORS;
  }

  find(app: string): Connector | undefined {
    return this.byApp.get(app);
  }

  require(app: string): Connector {
    const connector = this.find(app);
    if (!connector) {
      throw new BadRequestException(`Unknown app "${app}".`);
    }
    return connector;
  }

  requireAction(app: string, actionId: string): ConnectorAction {
    const connector = this.require(app);
    const action = connector.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new BadRequestException(
        `"${actionId}" is not an action of ${connector.name}.`,
      );
    }
    return action;
  }

  /** Which OAuth scopes a whole app needs — the union of its actions'. */
  scopesForApp(app: string): string[] {
    const connector = this.require(app);
    return Array.from(new Set(connector.actions.flatMap((a) => a.scopes)));
  }

  /**
   * The catalogue as the automation editor sees it.
   *
   * `execute` and `resources` are stripped: they are server-side
   * functions, and JSON.stringify would drop them anyway — doing it
   * explicitly means the type says so.
   */
  catalog(): CatalogApp[] {
    return CONNECTORS.map((connector) => ({
      provider: connector.provider,
      app: connector.app,
      name: connector.name,
      blurb: connector.blurb,
      monogram: connector.monogram,
      hue: connector.hue,
      // Built field-by-field rather than by spreading and deleting
      // `execute`: destructuring a method off the object detaches it from
      // its `this`, and an explicit list makes it impossible to leak a
      // server-side function into a JSON response by adding a field to
      // ConnectorAction later.
      actions: connector.actions.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        scopes: action.scopes,
        inputs: action.inputs,
        outputs: action.outputs,
        irreversible: action.irreversible,
      })),
    }));
  }
}
