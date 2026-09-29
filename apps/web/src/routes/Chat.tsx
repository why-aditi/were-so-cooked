import { useAgentChat } from '@cloudflare/ai-chat/react';
import type { UIMessage } from 'ai';
import { useAgent } from 'agents/react';
import { useEffect, useRef, useState } from 'react';
import {
  ApprovalCard,
  PantryDiffCard,
  PlanProgressCard,
  RecipeCard,
  ScanConfirmCard,
  SubstitutionCard,
  type ScanConfirmItem,
} from '../cards/Cards';
import { Composer } from '../components/Composer';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * The chat screen (sections 5, 10 and 11).
 *
 * `useAgent` opens the socket at /agents/kitchen-agent/{userId} and
 * `useAgentChat` drives the transcript, the streaming and the tool-approval
 * round trip. The cards are rendered from the structured tool parts on each
 * message rather than parsed out of the prose — section 5 is explicit that
 * "recipe, pantry and plan results render as cards from structured tool
 * output, not from parsed prose", and a regex over model text would be
 * exactly the fragility that rule exists to avoid.
 */

type ToolPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  approval?: { id: string; approved?: boolean };
};

const isToolPart = (part: unknown): part is ToolPart =>
  typeof part === 'object' && part !== null && String((part as { type?: string }).type).startsWith('tool-');

const toolNameOf = (part: ToolPart): string => part.type.replace(/^tool-/, '');

export function Chat() {
  const { user } = useSession();
  const [scanItems, setScanItems] = useState<Record<string, ScanConfirmItem[]>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({ agent: 'kitchen-agent', name: user.id });

  const { messages, sendMessage, status, addToolApprovalResponse } = useAgentChat({ agent });

  const busy = status === 'submitted' || status === 'streaming';

  // Only follow the thread when the newest message changes, not on every
  // streamed token — otherwise a long answer fights anyone scrolling back.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const onPhoto = async (file: File) => {
    setUploadError(null);
    try {
      const { scanId } = await api.uploadPhoto(file);
      // The Workflow extracts in the background; poll the scan until the
      // confirm list is ready. Section 6: a parked Workflow reports
      // `running`, so the scan row is the only thing that knows.
      void pollScan(scanId);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'The upload failed. Try again.');
    }
  };

  const pollScan = async (scanId: string) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      try {
        const { scan } = await api.scan(scanId);
        if (scan.status === 'awaiting_confirm') {
          setScanItems((current) => ({ ...current, [scanId]: scan.items as ScanConfirmItem[] }));
          return;
        }
        if (scan.status === 'failed') {
          setUploadError(scan.error ?? 'That scan did not work out.');
          return;
        }
      } catch {
        // A blip while polling is not worth surfacing; the loop retries and
        // gives up quietly after a minute.
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mx-auto max-w-[46rem]">
          {messages.length === 0 ? <EmptyThread /> : null}

          {messages.map((message: UIMessage) => (
            <Message
              key={message.id}
              message={message}
              onApprove={(id, approved) => addToolApprovalResponse({ id, approved })}
            />
          ))}

          {Object.entries(scanItems).map(([scanId, items]) => (
            <ScanConfirmCard
              key={scanId}
              id={scanId}
              items={items}
              pending={false}
              onToggle={(index) =>
                setScanItems((current) => ({
                  ...current,
                  [scanId]: (current[scanId] ?? []).map((item, i) =>
                    i === index ? { ...item, selected: !item.selected } : item,
                  ),
                }))
              }
              onConfirm={async () => {
                await api.confirmScan(scanId, items as never);
                setScanItems((current) => {
                  const next = { ...current };
                  delete next[scanId];
                  return next;
                });
              }}
            />
          ))}

          {uploadError ? (
            <p role="alert" className="my-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
              {uploadError}
            </p>
          ) : null}

          <div ref={endRef} />
        </div>
      </div>

      <Composer
        onSend={(text) => sendMessage({ text })}
        onPhoto={onPhoto}
        disabled={false}
        busy={busy}
      />
    </div>
  );
}

/* --------------------------------- message -------------------------------- */

function Message({
  message,
  onApprove,
}: {
  message: UIMessage;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const isUser = message.role === 'user';
  const text = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');

  return (
    <div className={isUser ? 'flex justify-end' : ''}>
      <div className={isUser ? 'max-w-[85%]' : 'w-full'}>
        {text ? (
          <p
            className={
              isUser
                ? 'my-2 inline-block rounded-2xl rounded-br-sm px-3.5 py-2 whitespace-pre-wrap'
                : 'my-2 whitespace-pre-wrap'
            }
            style={
              isUser
                ? { background: 'var(--surface-high)', border: '2px solid var(--line)' }
                : undefined
            }
          >
            {text}
          </p>
        ) : null}

        {message.parts.filter(isToolPart).map((part: ToolPart, index: number) => (
          <ToolCard key={part.toolCallId ?? index} part={part} onApprove={onApprove} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ tool to card ------------------------------ */

function ToolCard({
  part,
  onApprove,
}: {
  part: ToolPart;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const name = toolNameOf(part);
  const id = part.toolCallId ?? name;

  // Approval comes first: while a call is waiting on the user, the card that
  // matters is the confirmation, not whatever the tool would have returned.
  if (part.approval && part.approval.approved === undefined) {
    const summary = summariseApproval(name, part.input);
    return (
      <ApprovalCard
        toolName={name}
        summary={summary}
        pending={false}
        onApprove={() => onApprove(part.approval?.id ?? '', true)}
        onReject={() => onApprove(part.approval?.id ?? '', false)}
      />
    );
  }

  if (part.state !== 'output-available' || part.output === undefined) return null;
  const output = part.output as Record<string, unknown>;

  if (name === 'add_pantry_items' || name === 'remove_pantry_items' || name === 'log_cooked') {
    return (
      <PantryDiffCard
        id={id}
        added={(output.added as never[]) ?? []}
        removed={(output.removed as string[]) ?? []}
        unverified={(output.unverified as string[]) ?? []}
      />
    );
  }

  if (name === 'suggest_recipes') {
    const suggestions = (output.suggestions as never[]) ?? [];
    const hidden = (output.hidden as { title: string; reason: string }[]) ?? [];
    return (
      <>
        {suggestions.map((recipe) => (
          <RecipeCard key={(recipe as { id: string }).id} recipe={recipe} />
        ))}
        {hidden.length > 0 ? <HiddenNotice hidden={hidden} /> : null}
      </>
    );
  }

  if (name === 'substitute') {
    if (output.ok === false) {
      return <HiddenNotice hidden={[{ title: String(output.title ?? 'That dish'), reason: String(output.reason) }]} />;
    }
    return (
      <SubstitutionCard
        id={id}
        title={String(output.title ?? 'that dish')}
        swaps={(output.swaps as never[]) ?? []}
      />
    );
  }

  if (name === 'start_weekly_plan') {
    return <PlanProgressCard id={id} steps={(output.steps as never[]) ?? []} />;
  }

  return null;
}

/**
 * Recipes the safety engine removed.
 *
 * Section 10 gives this copy exactly: "Removed this recipe because it
 * contains peanuts, which are on your allergy list." Plain, sentence case,
 * no emoji — and rendered `sober` for the same reason.
 */
function HiddenNotice({ hidden }: { hidden: { title: string; reason: string }[] }) {
  return (
    <section className="sober sober-warn my-3 max-w-[34rem] p-4">
      <h3 className="mb-2 text-[1rem]">Some dishes were removed</h3>
      <ul className="space-y-1.5 text-[0.92rem]">
        {hidden.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong> — {item.reason}
          </li>
        ))}
      </ul>
      <p className="mt-3 mb-0 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
        Always check labels. If you have a severe allergy, verify every ingredient yourself.
      </p>
    </section>
  );
}

/**
 * The card body for a paused tool.
 *
 * The agent can compute a richer preview over RPC, but the input is already
 * on the message and rendering it immediately beats a card that appears
 * blank for a round trip.
 */
function summariseApproval(name: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === 'log_cooked') {
    const servings = args.servings ? ` (${String(args.servings)}x)` : '';
    return [
      `Log "${String(args.recipe_title ?? 'that dish')}"${servings} and deduct its ingredients from your pantry.`,
    ];
  }

  if (name === 'update_profile') {
    const lines: string[] = [];
    const list = (key: string, label: string) => {
      const value = args[key];
      if (Array.isArray(value)) {
        lines.push(`${label}: ${value.length > 0 ? value.join(', ') : 'none'}`);
      }
    };
    list('allergens', 'Allergens');
    list('diets', 'Diets');
    list('exclusions', 'Will not eat');
    list('cuisines', 'Cuisines');
    if (Array.isArray(args.allergens) && args.allergens.length === 0) {
      lines.push('This clears your allergy list. Recipes containing those will no longer be hidden.');
    }
    return lines.length > 0 ? lines : ['Update your profile.'];
  }

  return ['This needs your confirmation.'];
}

/* ---------------------------------- empty --------------------------------- */

/** An empty screen is an invitation to act, so it suggests the first move. */
function EmptyThread() {
  return (
    <div className="py-10">
      <h2 className="text-[2rem] mb-3">your fridge is in witness protection 👀</h2>
      <p style={{ color: 'var(--text-muted)' }}>tell me what you bought, or point a camera at it.</p>
      <ul className="mt-5 space-y-2 p-0 list-none">
        {[
          'bought 1kg paneer, 6 eggs and a bunch of dhaniya',
          'what can i make tonight',
          'made palak paneer',
        ].map((example) => (
          <li key={example} className="text-[0.92rem]" style={{ color: 'var(--text-muted)' }}>
            “{example}”
          </li>
        ))}
      </ul>
    </div>
  );
}
