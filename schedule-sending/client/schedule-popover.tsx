import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text } from "react-native";
import { addScheduleRpc, cancelScheduleRpc, listScheduleRpc } from "../shared/rpc";
import { listQueryKey } from "./query-keys";
import { ScheduleForm } from "./schedule-form";
import { ScheduleList } from "./schedule-list";

const REFETCH_MS = 5_000;
const CLOCK_MS = 15_000;

type AgentProps = Extract<PluginButtonContentProps, { context: "agent" }>;

export function SchedulePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <AgentSchedule {...props} />;
}

function AgentSchedule({ theme, layout, agentId }: AgentProps) {
  const list = useRpc(listScheduleRpc);
  const add = useRpc(addScheduleRpc);
  const cancel = useRpc(cancelScheduleRpc);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => listQueryKey(agentId), [agentId]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const query = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: REFETCH_MS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const addMutation = useMutation({ mutationFn: add, onSuccess: refresh });
  const cancelMutation = useMutation({ mutationFn: cancel, onSuccess: refresh });

  const styles = useMemo(
    () => ({
      screen: {
        padding: layout.compact ? 12 : 16,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <ScheduleForm
        theme={theme}
        layout={layout}
        now={now}
        busy={addMutation.isPending}
        error={addMutation.error?.message ?? null}
        onSubmit={(text, fireAt) => addMutation.mutateAsync({ agentId, text, fireAt })}
      />
      {query.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {query.error ? <Text style={styles.error}>{query.error.message}</Text> : null}
      {cancelMutation.error ? <Text style={styles.error}>{cancelMutation.error.message}</Text> : null}
      {query.data ? (
        <ScheduleList
          theme={theme}
          layout={layout}
          items={query.data.items}
          now={now}
          cancelingId={cancelMutation.isPending ? (cancelMutation.variables?.id ?? null) : null}
          onCancel={(id) => cancelMutation.mutate({ id })}
        />
      ) : null}
    </ScrollView>
  );
}
