import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const WorkerMock = vi.fn(function (this: any, url: unknown, opts: unknown) {
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    this.addEventListener = vi.fn();
    this.removeEventListener = vi.fn();
    (this as any)._url = url;
    (this as any)._opts = opts;
  });
  return { WorkerMock };
});

vi.stubGlobal("Worker", mocks.WorkerMock);

import { RdfReasoner } from "../../ts/index.js";

describe("RdfReasoner workerUrl", () => {
  it("uses import.meta.url when no options provided", () => {
    new RdfReasoner();
    expect(mocks.WorkerMock).toHaveBeenCalledTimes(1);
    const url = mocks.WorkerMock.mock.calls[0][0];
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toContain("worker.js");
  });

  it("uses provided string workerUrl", () => {
    mocks.WorkerMock.mockClear();
    new RdfReasoner({ workerUrl: "https://cdn.example.com/worker.js" });
    expect(mocks.WorkerMock).toHaveBeenCalledTimes(1);
    const url = mocks.WorkerMock.mock.calls[0][0];
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://cdn.example.com/worker.js");
  });

  it("uses provided URL workerUrl", () => {
    mocks.WorkerMock.mockClear();
    const workerUrl = new URL("https://cdn.example.com/custom-worker.js");
    new RdfReasoner({ workerUrl });
    expect(mocks.WorkerMock).toHaveBeenCalledTimes(1);
    const url = mocks.WorkerMock.mock.calls[0][0];
    expect(url.href).toBe("https://cdn.example.com/custom-worker.js");
  });
});
