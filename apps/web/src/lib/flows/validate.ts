/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  scope: 'flow' | 'trigger' | 'node';
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
}

interface FlowInput {
  name: string;
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: 'error',
      scope: 'flow',
      field: 'name',
      message: 'Flow name is required.',
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: 'error',
      scope: 'flow',
      field: 'entry_node_id',
      message: 'Pick an entry node before activating.',
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: 'error',
      scope: 'flow',
      message: 'A flow needs at least one node before activation.',
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: 'error',
      scope: 'flow',
      field: 'entry_node_id',
      message: `Entry node "${flow.entry_node_id}" doesn't exist.`,
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: 'error',
        scope: 'node',
        node_key: n.node_key,
        message: `Duplicate node_key "${n.node_key}".`,
      });
    }
    seen.add(n.node_key);
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  for (const n of nodes) {
    issues.push(...validateNode(n, keys));
  }

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: 'warning',
          scope: 'node',
          node_key: n.node_key,
          message: `Node "${n.node_key}" is unreachable from the entry node.`,
        });
      }
    }
  }

  return issues;
}

// ============================================================
// Trigger
// ============================================================

function validateTrigger(
  trigger_type: FlowInput['trigger_type'],
  trigger_config: Record<string, unknown>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (trigger_type === 'keyword') {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: 'error',
        scope: 'trigger',
        field: 'trigger_config.keywords',
        message: 'Keyword triggers need at least one keyword.',
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== 'string' || !k.trim()
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: 'warning',
          scope: 'trigger',
          field: 'trigger_config.keywords',
          message: `${blanks} keyword${blanks === 1 ? ' is' : 's are'} blank — they won't match anything.`,
        });
      }
    }
  }
  // first_inbound_message / manual have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

/**
 * "This node must point somewhere, and somewhere real."
 *
 * Every linear node type repeats the same two checks. The pre-existing
 * types still spell them out inline (they carry bespoke wording that
 * users have seen for a year); everything added since shares this.
 */
function requireNext(
  node: NodeInput,
  nextKey: string | undefined,
  knownKeys: Set<string>,
  label: string
): ValidationIssue[] {
  if (!nextKey) {
    return [
      {
        severity: 'error',
        scope: 'node',
        node_key: node.node_key,
        field: 'next_node_key',
        message: `${label} must point to a next node.`,
      },
    ];
  }
  if (!knownKeys.has(nextKey)) {
    return [
      {
        severity: 'error',
        scope: 'node',
        node_key: node.node_key,
        field: 'next_node_key',
        message: `${label} points to non-existent node "${nextKey}".`,
      },
    ];
  }
  return [];
}

/**
 * Does this wait cross WhatsApp's 24-hour customer-service window?
 *
 * Exported for the test that pins the boundary: exactly 24 hours
 * counts, because the window is closed AT 24 hours, not after.
 */
export function waitExceedsWindow(
  duration: number | undefined,
  unit: string | undefined
): boolean {
  if (typeof duration !== 'number' || duration <= 0) return false;
  const hours =
    unit === 'days'
      ? duration * 24
      : unit === 'minutes'
        ? duration / 60
        : duration;
  return hours >= 24;
}

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case 'start': {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Start node must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Start points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'send_message': {
      const cfg = node.config as { text?: string; next_node_key?: string };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'text',
          message: 'Send-message node needs a text body.',
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Send-message node must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Send-message points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'send_media': {
      const cfg = node.config as {
        media_type?: 'image' | 'video' | 'document';
        media_url?: string;
        caption?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !['image', 'video', 'document'].includes(cfg.media_type)
      ) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'media_type',
          message:
            'Send-media node needs a media type (image, video, or document).',
        });
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'media_url',
          message:
            'Send-media node needs a file (upload one before activating).',
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (
        cfg.caption &&
        cfg.caption.length > INTERACTIVE_LIMITS.bodyMaxLength
      ) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'caption',
          message: `Caption exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars (WhatsApp limit).`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Send-media node must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Send-media points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'send_buttons': {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'text',
          message: 'Send-buttons node needs a text body.',
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'buttons',
          message: 'Send-buttons needs at least one button.',
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'buttons',
          message: `WhatsApp allows at most ${INTERACTIVE_LIMITS.maxButtons} buttons per message.`,
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Button ${i + 1} needs a reply id.`,
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Duplicate button reply id "${b.reply_id}".`,
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.title`,
            message: `Button ${i + 1} needs a title.`,
          });
        } else if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.title`,
            message: `Button ${i + 1} title is over ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars (WhatsApp limit).`,
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `Button ${i + 1} needs a next node.`,
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `Button ${i + 1} points to non-existent node "${b.next_node_key}".`,
          });
        }
      });
      break;
    }

    case 'send_list': {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'text',
          message: 'Send-list node needs a text body.',
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'button_label',
          message: 'Send-list needs a button label (the tap-to-expand text).',
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0
      );
      if (totalRows < 1) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'sections',
          message: 'Send-list needs at least one row.',
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'sections',
          message: `Send-list allows at most ${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across sections.`,
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `Row ${ri + 1} in section ${si + 1} needs a reply id.`,
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `Duplicate list row id "${row.reply_id}".`,
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.title`,
              message: `Row ${ri + 1} needs a title.`,
            });
          } else if (
            row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.title`,
              message: `Row ${ri + 1} title exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`,
            });
          }
          if (
            row.description &&
            row.description.length >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.description`,
              message: `Row ${ri + 1} description exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`,
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `Row ${ri + 1} needs a next node.`,
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: 'error',
              scope: 'node',
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `Row ${ri + 1} points to non-existent node "${row.next_node_key}".`,
            });
          }
        });
      });
      break;
    }

    case 'collect_input': {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'prompt_text',
          message: 'Collect-input needs a prompt to send the customer.',
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'var_key',
          message: 'Collect-input needs a var_key to store the answer under.',
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'var_key',
          message: `var_key "${cfg.var_key}" must be alphanumeric+underscore and start with a letter or underscore.`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Collect-input must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Collect-input points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'condition': {
      const cfg = node.config as {
        subject?: 'var' | 'tag' | 'contact_field';
        subject_key?: string;
        operator?: 'equals' | 'contains' | 'present' | 'absent';
        value?: string;
        true_next?: string;
        false_next?: string;
      };
      if (
        !cfg.subject ||
        !['var', 'tag', 'contact_field'].includes(cfg.subject)
      ) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'subject',
          message: 'Condition needs a subject (var / tag / contact_field).',
        });
      }
      if (!cfg.subject_key?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'subject_key',
          message:
            'Condition needs a subject_key (var name, tag id, or field name).',
        });
      }
      if (
        !cfg.operator ||
        !['equals', 'contains', 'present', 'absent'].includes(cfg.operator)
      ) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'operator',
          message: 'Condition needs an operator.',
        });
      } else if (
        (cfg.operator === 'equals' || cfg.operator === 'contains') &&
        (cfg.value === undefined || cfg.value === '')
      ) {
        issues.push({
          severity: 'warning',
          scope: 'node',
          node_key: node.node_key,
          field: 'value',
          message: `Operator "${cfg.operator}" usually expects a comparison value — empty value will only match empty subjects.`,
        });
      }
      for (const branch of ['true_next', 'false_next'] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: branch,
            message: `Condition needs a node for the "${branch === 'true_next' ? 'true' : 'false'}" branch.`,
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: 'error',
            scope: 'node',
            node_key: node.node_key,
            field: branch,
            message: `Condition's "${branch}" points to non-existent node "${key}".`,
          });
        }
      }
      break;
    }

    case 'set_tag': {
      const cfg = node.config as {
        mode?: 'add' | 'remove';
        tag_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !['add', 'remove'].includes(cfg.mode)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'mode',
          message: 'Set-tag needs a mode (add or remove).',
        });
      }
      if (!cfg.tag_id) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'tag_id',
          message: 'Set-tag needs a tag to apply.',
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Set-tag must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Set-tag points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'set_segment': {
      const cfg = node.config as {
        mode?: 'add' | 'remove';
        segment_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !['add', 'remove'].includes(cfg.mode)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'mode',
          message: 'Set-segment needs a mode (add or remove).',
        });
      }
      if (!cfg.segment_id) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'segment_id',
          message: 'Set-segment needs a segment.',
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: 'Set-segment must point to a next node.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'next_node_key',
          message: `Set-segment points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case 'set_attribute': {
      const cfg = node.config as {
        target?: string;
        key?: string;
        value?: string;
        next_node_key?: string;
      };
      if (
        !cfg.target ||
        !['contact_field', 'custom_field', 'var'].includes(cfg.target)
      ) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'target',
          message: 'Set-attribute needs somewhere to write to.',
        });
      }
      if (!cfg.key?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'key',
          message: 'Set-attribute needs a field or variable name.',
        });
      }
      // An empty value is legitimate — clearing a field is a real
      // thing to want — so only the destination is required.
      issues.push(
        ...requireNext(node, cfg.next_node_key, knownKeys, 'Set-attribute')
      );
      break;
    }

    case 'send_template': {
      const cfg = node.config as {
        template_name?: string;
        language?: string;
        next_node_key?: string;
      };
      if (!cfg.template_name?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'template_name',
          message: 'Pick a template to send.',
        });
      }
      if (!cfg.language?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'language',
          message: 'A template needs its language code (e.g. en_US).',
        });
      }
      issues.push(
        ...requireNext(node, cfg.next_node_key, knownKeys, 'Template')
      );
      break;
    }

    case 'send_products': {
      const cfg = node.config as {
        mode?: string;
        product_retailer_ids?: unknown;
        body_text?: string;
        next_node_key?: string;
      };
      const ids = Array.isArray(cfg.product_retailer_ids)
        ? cfg.product_retailer_ids.filter(
            (id): id is string => typeof id === 'string' && id.trim().length > 0
          )
        : [];
      if (ids.length === 0) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'product_retailer_ids',
          message: 'Add at least one product.',
        });
      }
      if (cfg.mode === 'single' && ids.length > 1) {
        issues.push({
          severity: 'warning',
          scope: 'node',
          node_key: node.node_key,
          field: 'product_retailer_ids',
          message:
            'A single-product message sends only the first product. Switch to a list to send them all.',
        });
      }
      // Meta requires a body on the multi-product message and rejects
      // the send without one — caught here rather than at send time,
      // where it is a failed run rather than a red field.
      if (cfg.mode === 'list' && !cfg.body_text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'body_text',
          message: 'A product list needs body text.',
        });
      }
      issues.push(
        ...requireNext(node, cfg.next_node_key, knownKeys, 'Products')
      );
      break;
    }

    case 'ask_location':
    case 'ask_media': {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      const label =
        node.node_type === 'ask_location' ? 'Ask-location' : 'Ask-for-a-file';
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'prompt_text',
          message: `${label} needs a prompt to send.`,
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'var_key',
          message: `${label} needs a variable to save the answer in.`,
        });
      }
      issues.push(...requireNext(node, cfg.next_node_key, knownKeys, label));
      break;
    }

    case 'wait': {
      const cfg = node.config as {
        duration?: number;
        unit?: string;
        next_node_key?: string;
      };
      if (typeof cfg.duration !== 'number' || cfg.duration <= 0) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'duration',
          message: 'Wait needs a duration greater than zero.',
        });
      }
      if (!cfg.unit || !['minutes', 'hours', 'days'].includes(cfg.unit)) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'unit',
          message: 'Wait needs a unit (minutes, hours or days).',
        });
      }
      // ⚠️ The 24-hour window keeps running while a run is parked. A
      // wait this long means the next plain message will be REFUSED by
      // Meta unless the customer writes again first — a warning, not an
      // error, because a template send after it is perfectly valid and
      // so is a flow that expects the customer to reply.
      if (waitExceedsWindow(cfg.duration, cfg.unit)) {
        issues.push({
          severity: 'warning',
          scope: 'node',
          node_key: node.node_key,
          field: 'duration',
          message:
            "Waiting 24 hours or more closes WhatsApp's messaging window — after this, only a template will send unless the customer messages again.",
        });
      }
      issues.push(...requireNext(node, cfg.next_node_key, knownKeys, 'Wait'));
      break;
    }

    case 'http_request': {
      const cfg = node.config as {
        method?: string;
        url?: string;
        response_var?: string;
        next_node_key?: string;
      };
      if (!cfg.url?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'url',
          message: 'API request needs a URL.',
        });
      } else if (!/^https?:\/\//i.test(cfg.url.trim())) {
        // The server-side SSRF guard is the real gate; this is the
        // early, legible half of the same rule.
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'url',
          message: 'URL must start with http:// or https://.',
        });
      }
      if (!cfg.response_var?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'response_var',
          message: 'Pick a variable to store the response in.',
        });
      }
      issues.push(
        ...requireNext(node, cfg.next_node_key, knownKeys, 'API request')
      );
      break;
    }

    case 'start_flow': {
      const cfg = node.config as { flow_id?: string };
      if (!cfg.flow_id?.trim()) {
        issues.push({
          severity: 'error',
          scope: 'node',
          node_key: node.node_key,
          field: 'flow_id',
          message: 'Pick the flow to continue in.',
        });
      }
      break;
    }

    case 'handoff':
    case 'ai_handoff':
    case 'end':
      // Terminal nodes have no outgoing edges; nothing to validate
      // beyond their existence. `ai_handoff` carries an optional
      // agent_id: unset is the meaningful default ("whichever agent
      // routing picks"), so there is nothing to require.
      break;

    default:
      issues.push({
        severity: 'error',
        scope: 'node',
        node_key: node.node_key,
        message: `Unknown node type "${node.node_type}".`,
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[]
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    // ⚠️ Every LINEAR node type must be listed here, not just
    // validated above. A type missing from this switch falls to
    // `default: return []`, which makes it look terminal to the BFS —
    // so everything downstream of it is reported "unreachable" and the
    // flow cannot be activated, with the error pointing at innocent
    // nodes rather than at this list.
    case 'start':
    case 'send_message':
    case 'send_media':
    case 'send_template':
    case 'send_products':
    case 'collect_input':
    case 'ask_location':
    case 'ask_media':
    case 'wait':
    case 'set_tag':
    case 'set_segment':
    case 'set_attribute':
    case 'http_request': {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case 'condition': {
      const cfg = node.config as {
        true_next?: string;
        false_next?: string;
      };
      const out: string[] = [];
      if (cfg.true_next) out.push(cfg.true_next);
      if (cfg.false_next) out.push(cfg.false_next);
      return out;
    }
    case 'send_buttons': {
      const cfg = node.config as {
        buttons?: Array<{ next_node_key?: string }>;
      };
      return (cfg.buttons ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case 'send_list': {
      const cfg = node.config as {
        sections?: Array<{ rows?: Array<{ next_node_key?: string }> }>;
      };
      const out: string[] = [];
      for (const s of cfg.sections ?? []) {
        for (const r of s.rows ?? []) {
          if (r.next_node_key) out.push(r.next_node_key);
        }
      }
      return out;
    }
    case 'handoff':
    case 'ai_handoff':
    case 'start_flow':
    case 'end':
    default:
      return [];
  }
}
