import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { effortInspect, effortSet, type EffortState } from "../shared/contracts";
import type { ComposerActions, ComposerExtension, DirectoryAgent } from "./pills";
import { bindMenu, desktopWeb, focusRow, panelWidth, registerIcon, retainCoordinator, radioRole, type MenuHandle, type Target } from "./web";

type RecordState = {
  agent: DirectoryAgent; actions: ComposerActions; pill: PluginButtonRegistration;
  active: boolean; saving: boolean; revision: number;
  listeners: Set<() => void>; refresh(): void;
};
function levelLabel(state: EffortState) {
  const label = state.options.find(option => option.id === state.selected)?.label;
  return label ? `${label}${state.inherited ? " (default)" : ""}` : "Unavailable";
}
function target(props: PluginButtonIconProps | PluginButtonContentProps): Target | null {
  return props.context === "agent" ? { hostId: props.host.id, workspaceId: props.workspaceId, agentId: props.agentId } : null;
}

export function createEffortExtension(client: PluginClientContext): ComposerExtension & { dispose(): void } {
  const records = new Map<string, RecordState>();
  const release = retainCoordinator();
  let revision = 0;
  const remove = (id: string) => {
    const record = records.get(id);
    if (record) { record.active = false; record.pill.remove(); records.delete(id); }
  };
  return {
    update(agent, actions) {
      if (!desktopWeb() || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
      const previous = records.get(agent.id);
      if (previous && previous.agent.workspaceId === agent.workspaceId && previous.agent.provider === agent.provider &&
          (previous.agent.runtimeInfo?.model ?? previous.agent.model) === (agent.runtimeInfo?.model ?? agent.model)) {
        const changed = previous.agent.thinkingOptionId !== agent.thinkingOptionId || previous.agent.effectiveThinkingOptionId !== agent.effectiveThinkingOptionId;
        previous.agent = agent;
        previous.actions = actions;
        if (changed) previous.refresh();
        return;
      }
      remove(agent.id);
      const record = { agent, actions, active: true, saving: false, revision: ++revision, listeners: new Set() } as RecordState;
      let inspection = 0;
      const inspect = async () => {
        const generation = ++inspection;
        const expected = record.agent.runtimeInfo?.model ?? record.agent.model ?? null;
        const result = await client.rpc(effortInspect, { agentId: agent.id });
        if (result.state && (result.state.provider !== record.agent.provider || result.state.selection !== expected)) {
          if (record.active) record.pill.update({ label: "Effort: Reopen" });
          return { state: null, error: "Agent or model changed. Close and reopen Thinking level." };
        }
        if (record.active && generation === inspection && result.state) record.pill.update({ label: `Effort: ${levelLabel(result.state)}` });
        return result;
      };
      record.refresh = () => { void inspect().catch(() => {}); };
      function Icon(props: PluginButtonIconProps) {
        const ref = useRef<View>(null);
        useLayoutEffect(() => {
          const identity = target(props);
          return identity ? registerIcon(identity, ref.current, {
            canFast: () => record.active && record.actions.canFast(),
            toggleFast: () => record.actions.toggleFast(),
          }) : undefined;
        }, [props.host.id, props.workspaceId, props.context === "agent" ? props.agentId : null]);
        return <View ref={ref} collapsable={false}><Text style={{ color: props.color, fontSize: props.size }}>≡</Text></View>;
      }
      function Content(props: PluginButtonContentProps) {
        return <EffortMenu {...props} record={record} inspect={inspect} client={client} />;
      }
      record.pill = client.addComposerPill({ id: "effort", agentId: agent.id, workspaceId: agent.workspaceId,
        button: { title: "Thinking level", label: "Effort", icon: Icon, behavior: { kind: "popover", Content } } });
      records.set(agent.id, record);
    },
    remove,
    dispose() { for (const id of records.keys()) remove(id); release(); },
  };
}

function EffortMenu(props: PluginButtonContentProps & {
  record: RecordState;
  inspect(): Promise<{ state: EffortState | null; error: string | null }>;
  client: PluginClientContext;
}) {
  const { theme: { colors }, record, client, inspect } = props;
  const root = useRef<View>(null);
  const rows = useRef<Array<View | null>>([]);
  const handle = useRef<MenuHandle | null>(null);
  const live = useRef(false);
  const keys = useRef<(key: string) => void>(() => {});
  const [bound, setBound] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const saving = useSyncExternalStore(listener => { record.listeners.add(listener); return () => { record.listeners.delete(listener); }; }, () => record.saving);
  const reconcileAfterWrite = useRef(saving);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const query = useQuery({ queryKey: ["effort", props.host.id, record.agent.id, record.revision], queryFn: inspect,
    enabled: bound, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const state = query.data?.state;
  const options = state?.options ?? [];
  // Cached data survives failed refetches and menu remounts. Only a successful
  // inspection in this mount can authorize choices, never retained data alone.
  const inspected = query.isSuccess && !query.isError && query.isFetchedAfterMount && !!state && !query.data?.error;
  const disabled = saving || record.saving || needsRefresh || query.isFetching || !bound || !inspected;
  useLayoutEffect(() => {
    live.current = true;
    const identity = target(props);
    handle.current = identity ? bindMenu(identity, root.current, props.close, key => keys.current(key)) : null;
    setBound(!!handle.current);
    if (!handle.current) setError("Composer instance is ambiguous. Close duplicate panes and reopen the menu.");
    focusRow(root.current);
    return () => { live.current = false; handle.current?.release(); handle.current = null; };
  }, []);
  useEffect(() => {
    if (!query.isFetching && inspected && !needsRefresh && state) {
      const index = Math.max(0, options.findIndex(option => option.id === state.selected));
      setHighlight(index);
      focusRow(rows.current[index]);
    }
  }, [query.data, query.isFetching, inspected, needsRefresh]);
  useEffect(() => {
    if (reconcileAfterWrite.current && !saving) {
      reconcileAfterWrite.current = false;
      void query.refetch();
    }
  }, [saving]);
  const close = () => handle.current?.close(true);
  async function apply(index: number) {
    if (disabled || !record.active || !handle.current?.valid() || !state?.model) return;
    const option = options[index];
    if (!option) return;
    if (state.requested === option.id) { close(); return; }
    record.saving = true;
    for (const listener of record.listeners) listener();
    setError(null);
    setAnnouncement("Applying...");
    try {
      const result = await client.rpc(effortSet, { agentId: record.agent.id, expectedProvider: state.provider,
        expectedModel: state.model, thinkingOptionId: option.id });
      if (!live.current || !record.active) return;
      if (result.error || !result.state) {
        // Preserve the old check until an explicit read reconciles an uncertain write.
        setError(result.error ?? "Thinking update unconfirmed. Refresh before retrying.");
        setNeedsRefresh(true);
        setAnnouncement("Update unconfirmed");
        return;
      }
      record.pill.update({ label: `Effort: ${levelLabel(result.state)}`, title: "Thinking level saved for subsequent turns" });
      setAnnouncement("Thinking level saved for subsequent turns");
      close();
    } catch {
      if (live.current) { setError("Thinking update unconfirmed. Check the connection and refresh before retrying."); setNeedsRefresh(true); }
    } finally {
      record.saving = false;
      for (const listener of record.listeners) listener();
    }
  }
  keys.current = key => {
    if (key === "Escape") { close(); return; }
    if (disabled || options.length === 0) return;
    if (key === "Enter") { void apply(highlight); return; }
    const next = key === "Home" ? 0 : key === "End" ? options.length - 1 :
      (highlight + (key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    setHighlight(next);
    focusRow(rows.current[next]);
  };
  async function retry() {
    if (saving || record.saving) return;
    setError(null);
    setAnnouncement("Loading effort...");
    const result = await query.refetch();
    if (!live.current) return;
    setAnnouncement("");
    if (result.isSuccess && !result.isError && !result.error && result.data?.state && !result.data.error) setNeedsRefresh(false);
  }
  const failure = error ?? query.data?.error ?? (query.isError ? "Thinking catalog unavailable. Check the connection and retry." : null);
  const effective = state?.effective && state.effective !== state.requested && state.requested !== null ?
    options.find(option => option.id === state.effective)?.label ?? "unavailable" : null;
  return <View ref={root} collapsable={false} accessibilityRole="menu" accessibilityLabel="Thinking level" tabIndex={-1}
    style={{ width: panelWidth(), maxWidth: "100%", padding: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
    <Text style={{ color: colors.foreground, fontSize: 14, marginBottom: 4 }}>Thinking level</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>
      {saving ? "Applying..." : query.isPending || query.isFetching ? "Loading effort..." : announcement}
    </Text>
    <ScrollView style={{ maxHeight: 192 }} keyboardShouldPersistTaps="handled">
      {options.map((option, index) => <Pressable key={option.id} ref={ref => { rows.current[index] = ref; radioRole(ref); }}
        accessibilityRole="menuitem" accessibilityLabel={option.label}
        accessibilityState={{ checked: state?.selected === option.id, disabled }} tabIndex={highlight === index ? 0 : -1}
        onFocus={() => setHighlight(index)} onPress={() => { void apply(index); }}
        style={{ height: 32, flexDirection: "row", alignItems: "center", borderRadius: 4, borderWidth: 1,
          borderColor: highlight === index ? colors.accent : colors.surface1,
          backgroundColor: highlight === index ? colors.surface2 : colors.surface1, opacity: disabled ? 0.6 : 1 }}>
        <Text style={{ color: colors.foreground, width: 24, textAlign: "center" }}>{state?.selected === option.id ? "✓" : ""}</Text>
        <Text numberOfLines={1} style={{ color: colors.foreground, flexShrink: 1, fontSize: 13 }}>{option.label}</Text>
        {state?.inherited && state.selected === option.id ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}> default</Text> : null}
      </Pressable>)}
    </ScrollView>
    {!query.isFetching && state && options.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Thinking levels unavailable for this model</Text> : null}
    {state && !state.selected && options.length > 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Current level unavailable</Text> : null}
    {effective ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Effective: {effective}</Text> : null}
    {failure ? <View><Text accessibilityLiveRegion="assertive" style={{ color: colors.statusDanger, fontSize: 12 }}>{failure}</Text>
      {bound ? <Pressable accessibilityRole="button" accessibilityLabel="Refresh thinking levels" disabled={saving || query.isFetching} onPress={() => { void retry(); }}>
        <Text style={{ color: colors.accent, paddingVertical: 6 }}>Refresh / retry</Text>
      </Pressable> : null}</View> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginTop: 6 }}>Up/Down  Enter  Esc</Text>
  </View>;
}
