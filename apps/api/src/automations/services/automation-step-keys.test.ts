import { describe, expect, it } from 'vitest';
import { uniqueKey } from './automation-steps-tree.service';

/**
 * Step keys are what `{{ steps.<key>.… }}` resolves against and what the
 * canvas uses as a node id. They survive a save (row ids do not — saving
 * is delete-then-reinsert), so the rules here are a contract with every
 * token an author has already written.
 *
 * The web half is `uniqueStepKey()` in
 * apps/web/src/lib/automations/graph.ts and must agree: if the server
 * sanitises differently from the editor, a saved key stops matching the
 * tokens that reference it.
 */
describe('uniqueKey', () => {
  it('sanitises to what a token path can address', () => {
    // A dot would split the path and the token would silently resolve to
    // an empty string — the worst failure mode this system has.
    expect(uniqueKey('Look Up Order!', new Set())).toBe('look_up_order');
    expect(uniqueKey('order.total', new Set())).toBe('order_total');
    expect(uniqueKey('  spaced  out  ', new Set())).toBe('spaced_out');
  });

  it('prefers what the author typed when it is free', () => {
    expect(uniqueKey('http_request', new Set(), 'notify_sales')).toBe(
      'notify_sales',
    );
  });

  it('suffixes rather than overwriting an existing key', () => {
    const used = new Set(['send_message']);
    expect(uniqueKey('send_message', used)).toBe('send_message_2');
    expect(uniqueKey('send_message', used)).toBe('send_message_3');
  });

  it('falls back to "step" for input that sanitises to nothing', () => {
    expect(uniqueKey('!!!', new Set())).toBe('step');
  });

  it('caps length so a key stays readable in a token', () => {
    expect(uniqueKey('a'.repeat(200), new Set())).toHaveLength(48);
  });

  it('records each key it hands out, so two calls never collide', () => {
    const used = new Set<string>();
    const first = uniqueKey('tag', used);
    const second = uniqueKey('tag', used);
    expect(first).not.toBe(second);
    expect(used.size).toBe(2);
  });
});
