// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSubmission,
  resetSubmissions,
  submissionKey,
  submitOnce,
  useTokenAction,
} from './submit-once';

// React reads this flag to know that state updates in a test are expected.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

beforeEach(() => resetSubmissions());
afterEach(() => resetSubmissions());

const idle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe('submitOnce', () => {
  it("runs once per key; every later caller gets the first call's result", async () => {
    const run = vi.fn(async () => 'done');
    const results = await Promise.all([
      submitOnce('k', run),
      submitOnce('k', run),
      submitOnce('k', run),
    ]);
    expect(results).toEqual(['done', 'done', 'done']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a different key runs separately', async () => {
    const run = vi.fn(async () => 'x');
    await submitOnce(submissionKey('verify-email', TOKEN_A), run);
    await submitOnce(submissionKey('verify-email', TOKEN_B), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the same token for another purpose is another call', async () => {
    const run = vi.fn(async () => 'x');
    await submitOnce(submissionKey('verify-email', TOKEN_A), run);
    await submitOnce(submissionKey('reset-password', TOKEN_A), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failure is remembered (no silent re-POST of a used token) until it is forgotten', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('used'))
      .mockResolvedValueOnce('ok');
    await expect(submitOnce('k', run)).rejects.toThrow('used');
    await expect(submitOnce('k', run)).rejects.toThrow('used');
    expect(run).toHaveBeenCalledTimes(1);

    forgetSubmission('k');
    await expect(submitOnce('k', run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('useTokenAction', () => {
  const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

  it("sends the token exactly once under StrictMode's double effects, and reports the result", async () => {
    const run = vi.fn(async (token: string) => `verified:${token}`);
    const { result } = renderHook(() => useTokenAction('verify-email', TOKEN_A, run), {
      wrapper: strict,
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(TOKEN_A);
    expect(result.current).toEqual({ status: 'success', value: `verified:${TOKEN_A}` });
  });

  it('does not send again when the component is mounted again with the same token', async () => {
    const run = vi.fn(async () => 'ok');
    const first = renderHook(() => useTokenAction('verify-email', TOKEN_A, run), {
      wrapper: strict,
    });
    await waitFor(() => expect(first.result.current.status).toBe('success'));
    first.unmount();

    const second = renderHook(() => useTokenAction('verify-email', TOKEN_A, run), {
      wrapper: strict,
    });
    await waitFor(() => expect(second.result.current.status).toBe('success'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a different token sends its own request', async () => {
    const run = vi.fn(async () => 'ok');
    const a = renderHook(() => useTokenAction('verify-email', TOKEN_A, run), { wrapper: strict });
    const b = renderHook(() => useTokenAction('verify-email', TOKEN_B, run), { wrapper: strict });
    await waitFor(() => expect(a.result.current.status).toBe('success'));
    await waitFor(() => expect(b.result.current.status).toBe('success'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shows a failure and does not retry on its own', async () => {
    const run = vi.fn(async () => {
      throw new Error('invalid or expired');
    });
    const { result } = renderHook(() => useTokenAction('verify-email', TOKEN_A, run), {
      wrapper: strict,
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    await idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without a token', async () => {
    const run = vi.fn(async () => 'ok');
    renderHook(() => useTokenAction('verify-email', null, run), { wrapper: strict });
    await idle();
    expect(run).not.toHaveBeenCalled();
  });
});
