// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import type {
  ArtifactRecordsStatus,
  ArtifactRecordsTransport,
} from "@sourceweft/contracts/artifact-records";
import { ArtifactStorageBar } from "@sourceweft/builtin-tool-publish-artifact/ui/artifact-storage-ui";

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

function status(overrides: Partial<ArtifactRecordsStatus>) {
  return {
    storage: true,
    shared: true,
    author: { id: "u1", name: "Ada" },
    approval: null,
    consented: false,
    canApprove: false,
    ...overrides,
  } as ArtifactRecordsStatus;
}

function transport(
  current: ArtifactRecordsStatus,
  extra: Partial<ArtifactRecordsTransport> = {},
) {
  return {
    execute: vi.fn(),
    status: vi.fn().mockResolvedValue(current),
    ...extra,
  } as unknown as ArtifactRecordsTransport;
}

async function render(t: ArtifactRecordsTransport) {
  const mounted = await mountWithIntl(
    <ArtifactStorageBar transport={t} shared />,
  );
  await flush(3);
  return mounted;
}

test("an approver sees a prominent pending request they can review", async () => {
  const { container } = await render(transport(status({ canApprove: true })));
  const pending = container.querySelector(
    '[data-testid="artifact-approval-pending"]',
  );
  expect(pending?.textContent).toContain("Waiting for your approval");
  expect(button("Review request", pending!)).toBeTruthy();
});

test("a viewer sees who can approve and no approve controls", async () => {
  const { container } = await render(transport(status({ canApprove: false })));
  const pending = container.querySelector(
    '[data-testid="artifact-approval-pending"]',
  );
  expect(pending?.textContent).toContain("Waiting for approval");
  expect(pending?.textContent).toContain(
    "Only a workspace editor or admin can approve this version.",
  );
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

test("approving runs the transport and clears the pending notice", async () => {
  let approved = false;
  const approveShared = vi.fn(async () => {
    approved = true;
  });
  const t = transport(status({ canApprove: true }), { approveShared });
  (t.status as ReturnType<typeof vi.fn>).mockImplementation(async () =>
    approved
      ? status({
          canApprove: true,
          consented: true,
          approval: {
            approvedBy: { id: "u2", name: "Bo" },
            approvedAt: "2026-06-01T00:00:00.000Z",
          },
        })
      : status({ canApprove: true }),
  );
  const { container } = await render(t);
  await click(button("Review request"));
  await click(button("Approve this version"));
  await flush(3);
  expect(approveShared).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector('[data-testid="artifact-approval-pending"]'),
  ).toBeNull();
});

test("an already approved version shows no pending notice", async () => {
  const { container } = await render(
    transport(
      status({
        consented: true,
        approval: {
          approvedBy: { id: "u2", name: "Bo" },
          approvedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
    ),
  );
  expect(
    container.querySelector('[data-testid="artifact-approval-pending"]'),
  ).toBeNull();
});
