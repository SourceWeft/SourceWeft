import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

type DisclosureKind = "reasoning" | "tool-group";
type DisclosureState = {
  choices: ReadonlyMap<string, boolean>;
  setChoice: (key: string, open: boolean) => void;
};

const DisclosureContext = createContext<DisclosureState | null>(null);
const DisclosureScopeContext = createContext("");

function disclosureKey(scope: string, kind: DisclosureKind, id: string) {
  return JSON.stringify([scope, kind, id]);
}

// Keep only explicit choices above the changing workflow tree. Regrouping,
// collapsing a group, and switching message branches can unmount its rows.
export function ActivityDisclosureProvider({ children }: PropsWithChildren) {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const setChoice = useCallback((key: string, open: boolean) => {
    setChoices((current) => {
      if (current.get(key) === open) return current;
      return new Map(current).set(key, open);
    });
  }, []);
  const value = useMemo(() => ({ choices, setChoice }), [choices, setChoice]);
  return (
    <DisclosureContext.Provider value={value}>
      {children}
    </DisclosureContext.Provider>
  );
}

export function ActivityDisclosureScope({
  children,
  messageKey,
}: PropsWithChildren<{ messageKey: string }>) {
  return (
    <DisclosureScopeContext.Provider value={messageKey}>
      {children}
    </DisclosureScopeContext.Provider>
  );
}

export function useActivityDisclosure(
  kind: DisclosureKind,
  id: string,
  defaultOpen: boolean,
) {
  const state = useContext(DisclosureContext);
  const scope = useContext(DisclosureScopeContext);
  const key = disclosureKey(scope, kind, id);
  // Rows may also be used on their own, outside the message list.
  const [localChoices, setLocalChoices] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isOpen = (state?.choices ?? localChoices).get(key) ?? defaultOpen;
  const setOpen = (open: boolean) => {
    if (state) state.setChoice(key, open);
    else setLocalChoices((current) => new Map(current).set(key, open));
  };
  return [isOpen, setOpen] as const;
}

export function useHasManuallyExpandedReasoning(ids: string[]) {
  const state = useContext(DisclosureContext);
  const scope = useContext(DisclosureScopeContext);
  return ids.some(
    (id) => state?.choices.get(disclosureKey(scope, "reasoning", id)) === true,
  );
}
