import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listFlows,
  createFlow,
  updateFlowJson,
  publishFlow,
  deleteFlow,
} from './meta-flows-api.util';

// A minimal Response stand-in for the global fetch mock.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** Typed view of the Nth fetch(url, init) call. */
function fetchCall(n: number): [string, RequestInit] {
  return fetchMock.mock.calls[n] as [string, RequestInit];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('meta-flows-api.util', () => {
  it('listFlows requests the WABA flows edge with a bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'flow-1', name: 'A', status: 'DRAFT' }] }),
    );

    const flows = await listFlows({ wabaId: 'waba-1', accessToken: 'tok' });

    expect(flows).toHaveLength(1);
    expect(flows[0].id).toBe('flow-1');
    const [url, init] = fetchCall(0);
    expect(url).toContain('/waba-1/flows');
    expect(url).toContain('fields=id,name,status,categories,validation_errors');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('createFlow posts flow_json + categories and returns id/validation_errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'flow-9', success: true, validation_errors: [] }),
    );

    const result = await createFlow({
      wabaId: 'waba-1',
      accessToken: 'tok',
      name: 'My flow',
      categories: ['SURVEY'],
      flowJson: '{"version":"5.0"}',
    });

    expect(result.id).toBe('flow-9');
    expect(result.validation_errors).toEqual([]);
    const [url, init] = fetchCall(0);
    expect(url).toContain('/waba-1/flows');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'My flow',
      categories: ['SURVEY'],
      flow_json: '{"version":"5.0"}',
    });
  });

  it('updateFlowJson uploads multipart form-data and surfaces validation errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        validation_errors: [
          {
            error: 'INVALID_PROPERTY_VALUE',
            error_type: 'FLOW_JSON_ERROR',
            message: 'bad',
          },
        ],
      }),
    );

    const result = await updateFlowJson({
      flowId: 'flow-1',
      accessToken: 'tok',
      flowJson: '{"version":"5.0"}',
    });

    expect(result.validation_errors).toHaveLength(1);
    const [url, init] = fetchCall(0);
    expect(url).toContain('/flow-1/assets');
    expect(init.method).toBe('POST');
    // Body is FormData with the three required parts...
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('name')).toBe('flow.json');
    expect(form.get('asset_type')).toBe('FLOW_JSON');
    expect(form.get('file')).toBeInstanceOf(Blob);
    // ...and no manual Content-Type (fetch must set the multipart boundary).
    expect(
      (init.headers as Record<string, string>)['Content-Type'],
    ).toBeUndefined();
  });

  it('publishFlow POSTs to the publish edge', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    const result = await publishFlow({ flowId: 'flow-1', accessToken: 'tok' });
    expect(result.success).toBe(true);
    const [url, init] = fetchCall(0);
    expect(url).toContain('/flow-1/publish');
    expect(init.method).toBe('POST');
  });

  it('deleteFlow issues a DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await deleteFlow({ flowId: 'flow-1', accessToken: 'tok' });
    const [url, init] = fetchCall(0);
    expect(url).toContain('/flow-1');
    expect(init.method).toBe('DELETE');
  });

  it('surfaces Meta error messages on non-ok responses', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid parameter' } }, false, 400),
    );
    await expect(
      listFlows({ wabaId: 'waba-1', accessToken: 'tok' }),
    ).rejects.toThrow('Invalid parameter');
  });
});
