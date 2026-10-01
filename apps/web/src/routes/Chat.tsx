import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { useAgent } from 'agents/react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
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

type StepStatus = 'pending' | 'started' | 'done' | 'failed';

/**
 * Section 11's `plan.progress` broadcasts, by plan id then step name. A
 * context rather than a prop, because the card that reads it sits three
 * components below the socket that receives it.
 */
const PlanProgress = createContext<Record<string, Record<string, StepStatus>>>({});

function readPlanProgress(data: unknown): { planId: string; step: string; status: StepStatus } | null {
  if (typeof data !== 'string') return null;
  try {
    const event = JSON.parse(data) as { type?: string; planId?: string; step?: string; status?: string };
    if (event.type !== 'plan.progress' || !event.planId || !event.step) return null;
    if (event.status !== 'started' && event.status !== 'done' && event.status !== 'failed') return null;
    return { planId: event.planId, step: event.step, status: event.status };
  } catch {
    // The SDK's own frames share this socket; anything that is not ours is
    // simply not a progress event.
    return null;
  }
}

export function Chat() {
  const { user } = useSession();
  const [scanItems, setScanItems] = useState<Record<string, ScanConfirmItem[]>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const [planProgress, setPlanProgress] = useState<Record<string, Record<string, StepStatus>>>({});

  const agent = useAgent({
    agent: 'kitchen-agent',
    name: user.id,
    onMessage: (message: MessageEvent) => {
      const event = readPlanProgress(message.data);
      if (!event) return;
      setPlanProgress((current) => ({
        ...current,
        [event.planId]: { ...current[event.planId], [event.step]: event.status },
      }));
    },
  });

  const { messages, sendMessage, status, addToolApprovalResponse } = useAgentChat({ agent });

  const busy = status === 'submitted' || status === 'streaming';

  // A turn spends budget, and a refused one says the budget is gone, so the
  // meter refreshes as soon as either finishes rather than on its next
  // minute-long poll. Without this it read "100% left" beside a reply saying
  // 31 neurons remained.
  const queryClient = useQueryClient();
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) void queryClient.invalidateQueries({ queryKey: ['budget'] });
    wasBusy.current = busy;
  }, [busy, queryClient]);

  // Only follow the thread when the newest message changes, not on every
  // streamed token — otherwise a long answer fights anyone scrolling back.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy]);

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
    <PlanProgress.Provider value={planProgress}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <div className="mx-auto max-w-[46rem]">
            {messages.length === 0 ? <EmptyThread /> : null}

            {messages.map((message: UIMessage) => (
              <Message
                key={message.id}
                message={message}
                onApprove={(id, approved) => addToolApprovalResponse({ id, approved })}
              />
            ))}

            {busy ? <TypingBubble label={activityOf(messages)} /> : null}

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
        />
      </div>
    </PlanProgress.Provider>
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

  // In the order the turn produced them: a tool's card, then the words about
  // it. Rendering all the text first put "here are a few recipes" above the
  // recipes it was introducing. Adjacent text parts join into one paragraph.
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tool'; part: ToolPart })[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      const last = blocks.at(-1);
      const text = (part as { text: string }).text;
      if (last?.kind === 'text') last.text += text;
      else blocks.push({ kind: 'text', text });
    } else if (isToolPart(part)) {
      blocks.push({ kind: 'tool', part });
    }
  }

  return (
    <div className={isUser ? 'flex justify-end' : ''}>
      <div className={isUser ? 'max-w-[85%]' : 'w-full'}>
        {blocks.map((block, index) =>
          block.kind === 'text' ? (
            block.text.trim() ? (
              <p
                key={`text-${index}`}
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
                {block.text.trim()}
              </p>
            ) : null
          ) : (
            <ToolCard
              key={block.part.toolCallId ?? index}
              part={block.part}
              onApprove={onApprove}
            />
          ),
        )}
      </div>
    </div>
  );
}

/* ------------------------------ typing bubble ----------------------------- */

/** What the agent is doing while a tool runs, in the app's own voice. */
const TOOL_ACTIVITY: Record<string, string> = {
  add_pantry_items: 'updating your fridge',
  remove_pantry_items: 'updating your fridge',
  update_pantry_item: 'updating your fridge',
  restore_pantry_items: 'updating your fridge',
  list_pantry: 'checking your fridge',
  suggest_recipes: 'finding recipes',
  search_trending: 'checking what is trending',
  substitute: 'working out swaps',
  log_cooked: 'logging that',
  start_weekly_plan: 'starting your plan',
  get_plan: 'pulling up your plan',
  get_grocery_list: 'pulling up your list',
  check_grocery_item: 'ticking that off',
  remember_taste: 'noting that',
  update_profile: 'updating your profile',
};

/**
 * The bubble's label, or null for plain dots.
 *
 * A running tool names itself; anything else — the model reading the
 * message, or writing after a tool — is just the dots. Once the reply's
 * words start arriving the bubble has nothing left to say, so it goes.
 */
function activityOf(messages: UIMessage[]): string | null | false {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return null;
  const tail = last.parts.at(-1);
  if (tail?.type === 'text') return (tail as { text: string }).text.trim() ? false : null;
  if (tail && isToolPart(tail) && (tail.state === 'input-streaming' || tail.state === 'input-available')) {
    return TOOL_ACTIVITY[toolNameOf(tail)] ?? null;
  }
  return null;
}

/** Three bouncing dots in an agent-side bubble, with an optional label. */
function TypingBubble({ label }: { label: string | null | false }) {
  if (label === false) return null;
  return (
    <div className="my-2" role="status" aria-live="polite">
      <span
        className="inline-flex items-center gap-2.5 rounded-2xl rounded-bl-sm px-3.5 py-2.5"
        style={{ background: 'var(--surface-high)', border: '2px solid var(--line)' }}
      >
        <span className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {label ? (
          <span className="text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
            {label}…
          </span>
        ) : (
          <span className="sr-only">typing</span>
        )}
      </span>
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

  if (name === 'suggest_recipes' || name === 'search_trending') {
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
    return <PlanCard id={id} output={output} />;
  }

  return null;
}

/** The plan progress card, with the tool's initial steps updated live. */
function PlanCard({ id, output }: { id: string; output: Record<string, unknown> }) {
  const progress = useContext(PlanProgress);
  const live = progress[String(output.planId)] ?? {};
  const steps = ((output.steps as { name: string; status: StepStatus }[]) ?? []).map((step) => ({
    name: step.name,
    status: live[step.name] ?? step.status,
  }));
  return <PlanProgressCard id={id} steps={steps} />;
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
