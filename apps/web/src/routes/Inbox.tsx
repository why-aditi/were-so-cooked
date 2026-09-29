import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "Nudges and notices, mark read."
 *
 * The rows come from the agent's inbox table, which the 9am expiry job and
 * the 5pm suggestion write. Their copy is already in section 10's voice, so
 * this screen renders it rather than rewriting it — one source for a line
 * the user might see in a notification and again here.
 */

const KIND_LABEL: Record<string, string> = {
  expiry: 'expiry',
  tonight: 'tonight',
  plan_ready: 'plan',
  trending: 'trending',
  system: 'notice',
};

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Inbox() {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox });

  const read = useMutation({
    mutationFn: api.markRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });

  const items = inbox.data?.items ?? [];
  const unread = inbox.data?.unread ?? 0;

  return (
    <Screen title="inbox" lede={unread > 0 ? `${unread} unread` : 'all caught up'}>
      {inbox.isPending ? <Loading what="your nudges" /> : null}
      {inbox.isError ? (
        <LoadError
          error={inbox.error}
          onRetry={() => queryClient.invalidateQueries({ queryKey: ['inbox'] })}
        />
      ) : null}

      {inbox.isSuccess && items.length === 0 ? (
        <Empty line="nothing to report. suspiciously quiet in here 👀" />
      ) : null}

      <ul className="space-y-3 p-0 list-none">
        {items.map((item) => {
          const isUnread = item.readAt === null;
          return (
            <li
              key={item.id}
              className="sticker p-3.5"
              style={{
                ['--tilt' as string]: '0deg',
                // Unread is carried by a left bar and by the "new" chip, not
                // by opacity alone.
                borderLeftWidth: isUnread ? '6px' : '2px',
                borderLeftColor: isUnread ? 'var(--color-marigold)' : 'var(--text-primary)',
              }}
            >
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="chip" style={{ color: 'var(--text-muted)' }}>
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                <h2 className="text-[1.05rem]">{item.title}</h2>
                {isUnread ? (
                  <span className="chip" style={{ color: 'var(--text-act)' }}>
                    new
                  </span>
                ) : null}
                <time
                  className="ml-auto text-[0.8rem]"
                  style={{ color: 'var(--text-muted)' }}
                  dateTime={item.createdAt}
                >
                  {ago(item.createdAt)}
                </time>
              </div>

              {item.body ? <p className="mt-1.5 mb-0 text-[0.95rem]">{item.body}</p> : null}

              {isUnread ? (
                <button
                  type="button"
                  className="btn mt-3"
                  onClick={() => read.mutate(item.id)}
                  disabled={read.isPending}
                >
                  mark read<span className="sr-only">: {item.title}</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Screen>
  );
}
