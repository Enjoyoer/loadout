import { Platform } from "react-native";
import type { ComposerActions } from "./pills";

// Deliberately local: DOM markers are a checked 0.11.1 adapter, not a focus API.
interface ElementRef {
  parentElement: ElementRef | null; isConnected: boolean; tagName: string;
  closest(selector: string): ElementRef | null;
  querySelectorAll(selector: string): ArrayLike<ElementRef>;
  contains(node: unknown): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number };
  focus(options?: { preventScroll?: boolean }): void; click(): void;
  scrollIntoView(options: { block: "nearest" }): void;
  selectionStart?: number | null; selectionEnd?: number | null; selectionDirection?: string | null;
  setSelectionRange?(start: number, end: number, direction?: string): void;
}
interface KeyEvent {
  key: string; target: unknown; defaultPrevented: boolean; isComposing: boolean; keyCode: number;
  ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean;
  preventDefault(): void; stopPropagation(): void;
}
declare const document: { activeElement: ElementRef | null; querySelectorAll(selector: string): ArrayLike<ElementRef> };
declare const window: {
  innerWidth: number; innerHeight: number;
  addEventListener(name: string, listener: (event: KeyEvent) => void, capture: boolean): void;
  removeEventListener(name: string, listener: (event: KeyEvent) => void, capture: boolean): void;
  getComputedStyle(element: ElementRef): { display: string; visibility: string; opacity: string; overflowX: string; overflowY: string };
  requestAnimationFrame(callback: () => void): number; cancelAnimationFrame(id: number): void;
};
declare const navigator: { platform: string; userAgent: string };
export interface Target { hostId: string; workspaceId: string; agentId: string }
interface Instance { target: Target; token: symbol; icon: ElementRef; actions: ComposerActions }
interface Association { trigger: ElementRef; pane: ElementRef; composer: ElementRef; input: ElementRef }
interface Capture { instance: Instance; association: Association; start?: number | null; end?: number | null; direction?: string | null }
export interface MenuHandle { close(restore: boolean): void; release(): void; valid(): boolean }
interface Menu { instance: Instance | null; capture: Capture | null; root: ElementRef; target: Target; dismiss(): void; key(key: string): void; restore: boolean }
const instances = new Set<Instance>();
let opening: Capture | null = null;
let menu: Menu | null = null;
let users = 0;
let monitor: ReturnType<typeof setInterval> | undefined;
const frames = new Set<number>();
const same = (a: Target, b: Target) => a.hostId === b.hostId && a.workspaceId === b.workspaceId && a.agentId === b.agentId;
const element = (value: unknown): ElementRef | null => value && typeof (value as ElementRef).closest === "function" ? value as ElementRef : null;
function visible(node: ElementRef | null): node is ElementRef {
  if (!node?.isConnected || node.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  const bounds = node.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  let left = Math.max(0, bounds.left), right = Math.min(window.innerWidth, bounds.right);
  let top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
  for (let parent: ElementRef | null = node; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    if (parent !== node) {
      const clip = parent.getBoundingClientRect();
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
  }
  return right > left && bottom > top;
}
function associate(instance: Instance): Association | null {
  // The icon wrapper is aria-hidden by Paseo. Check the actual pressable instead.
  const trigger = instance.icon.closest('[role="button"], button');
  const pane = trigger?.closest('[data-testid^="workspace-pane-"]');
  if (!trigger || !pane || !visible(pane) || !visible(trigger) || trigger.getAttribute("aria-disabled") === "true") return null;
  for (let parent = trigger.parentElement; parent && pane.contains(parent); parent = parent.parentElement) {
    const composers = Array.from(parent.querySelectorAll('[data-testid="message-input-root"]')).filter(visible);
    if (composers.length > 1) return null;
    if (composers.length === 1) {
      const inputs = Array.from(composers[0].querySelectorAll('[data-composer-input]')).filter(visible);
      if (inputs.length !== 1 || !["TEXTAREA", "INPUT"].includes(inputs[0].tagName)) return null;
      return { trigger, pane, composer: composers[0], input: inputs[0] };
    }
    if (parent === pane) break;
  }
  return null;
}
function capture(instance: Instance, association: Association): Capture {
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = association.input;
  return { instance, association, start, end, direction };
}
function valid(value: Capture) {
  const current = instances.has(value.instance) ? associate(value.instance) : null;
  return !!current && current.pane === value.association.pane && current.input === value.association.input && current.trigger === value.association.trigger;
}
function overlays(root?: ElementRef) {
  return Array.from(document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], [data-menu-surface="true"], [data-testid="command-center-panel"]'))
    .some(node => visible(node) && (!root || !node.contains(root) && !root.contains(node)));
}
function owned(association: Association, node: unknown) {
  const target = element(node);
  return !!target && (association.composer.contains(target) || association.trigger.contains(target)) &&
    !target.closest('[role="dialog"], [role="menu"], [data-testid="terminal-surface"], .xterm');
}
function modifier(event: KeyEvent) {
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Macintosh|Mac OS|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
function consume(event: KeyEvent) { event.preventDefault(); event.stopPropagation(); }
function keyboard(event: KeyEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === "Process") return;
  if (menu) {
    if (!menu.root.contains(event.target) || !menu.root.contains(document.activeElement) || overlays(menu.root)) return;
    if (modifier(event) && event.key.toLowerCase() === "m") { consume(event); return; }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Escape"].includes(event.key)) {
      consume(event);
      if (!event.repeat) menu.key(event.key);
    }
    // The earlier host overlay owns Escape and traps boundary Tab. Do not bypass it.
    return;
  }
  const key = event.key.toLowerCase();
  if (!modifier(event) || !["f", "m"].includes(key) || overlays()) return;
  const matches = Array.from(instances).flatMap(instance => {
    const association = associate(instance);
    return association && owned(association, event.target) && owned(association, document.activeElement) ? [{ instance, association }] : [];
  });
  if (matches.length !== 1) return;
  const { instance, association } = matches[0];
  if (key === "f") {
    if (!instance.actions.canFast()) return;
    consume(event);
    if (!event.repeat) void instance.actions.toggleFast().catch(() => {}); // Shared action publishes its error at Fast.
    return;
  }
  // 0.11.1 shares open state by registration, not by mounted pane. Refuse duplicate surfaces.
  if (Array.from(instances).filter(other => same(other.target, instance.target) && associate(other)).length !== 1) return;
  consume(event);
  if (event.repeat || opening) return;
  opening = capture(instance, association);
  association.trigger.click();
}
function pointer(event: KeyEvent) {
  if (menu) {
    if (!menu.root.contains(event.target)) menu.restore = false;
    return;
  }
  const matches = Array.from(instances).flatMap(instance => {
    const association = associate(instance);
    return association?.trigger.contains(event.target) ? [capture(instance, association)] : [];
  });
  opening = matches.length === 1 ? matches[0] : null;
}
function check() {
  if (opening && (!valid(opening) || opening.association.trigger.getAttribute("aria-expanded") !== "true")) opening = null;
  if (menu && ((menu.capture && !valid(menu.capture)) || (menu.instance &&
      (!instances.has(menu.instance) || !visible(menu.instance.icon.closest('[role="button"], button')))))) {
    menu.restore = false; menu.dismiss();
  }
}
function restore(value: Capture, root: ElementRef) {
  const frame = window.requestAnimationFrame(() => {
    frames.delete(frame);
    // An outside click or a newer overlay must never lose its focus to a stale callback.
    if (!users || menu || !valid(value) || overlays()) return;
    const active = document.activeElement;
    if (active && active.tagName !== "BODY" && active !== value.association.trigger && !root.contains(active) && active !== value.association.input) return;
    value.association.input.focus({ preventScroll: true });
    if (value.start != null && value.end != null) value.association.input.setSelectionRange?.(value.start, value.end, value.direction ?? undefined);
  });
  frames.add(frame);
}
export function desktopWeb() {
  return Platform.OS === "web" && typeof window !== "undefined" && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}
export function retainCoordinator() {
  if (!desktopWeb()) return () => {};
  if (users++ === 0) {
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("pointerdown", pointer, true);
    monitor = setInterval(check, 200);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users !== 0) return;
    window.removeEventListener("keydown", keyboard, true);
    window.removeEventListener("pointerdown", pointer, true);
    clearInterval(monitor);
    for (const frame of frames) window.cancelAnimationFrame(frame);
    frames.clear();
    opening = null;
    if (menu) { menu.restore = false; menu.dismiss(); menu = null; }
    instances.clear();
  };
}
export function registerIcon(target: Target, ref: unknown, actions: ComposerActions) {
  if (!desktopWeb()) return () => {};
  const icon = element(ref);
  if (!icon) return () => {};
  const instance = { target, icon, actions, token: Symbol("composer-instance") };
  instances.add(instance);
  return () => {
    instances.delete(instance);
    if (opening?.instance === instance) opening = null;
    if (menu?.instance === instance) { menu.restore = false; menu.dismiss(); }
  };
}
export function bindMenu(target: Target, ref: unknown, dismiss: () => void, key: (key: string) => void): MenuHandle | null {
  if (!desktopWeb()) return null;
  const root = element(ref);
  if (!root || menu) return null;
  const candidates = Array.from(instances).filter(instance => same(instance.target, target) && visible(instance.icon.closest('[role="button"], button')));
  // Clicking still works without DOM discovery, but ambiguous duplicate panes cannot mutate.
  if (candidates.length > 1) return null;
  const captured = opening && same(opening.instance.target, target) && valid(opening) ? opening : null;
  opening = null;
  const ownedMenu: Menu = { root, target, instance: captured?.instance ?? candidates[0] ?? null, capture: captured, dismiss, key, restore: !!captured };
  menu = ownedMenu;
  return {
    valid: () => menu === ownedMenu && (!captured || valid(captured)) && (!ownedMenu.instance ||
      instances.has(ownedMenu.instance) && visible(ownedMenu.instance.icon.closest('[role="button"], button'))),
    close(shouldRestore) { ownedMenu.restore = shouldRestore && !!captured; dismiss(); },
    release() {
      if (menu !== ownedMenu) return;
      menu = null;
      if (ownedMenu.restore && captured) restore(captured, root);
    },
  };
}
export function focusRow(ref: unknown) {
  if (Platform.OS !== "web") return;
  const node = element(ref);
  node?.focus({ preventScroll: true });
  if (node?.getAttribute("role") === "menuitemradio") node.scrollIntoView({ block: "nearest" });
}
export function panelWidth() { return Platform.OS === "web" ? Math.max(0, Math.min(232, window.innerWidth - 16)) : 232; }
// RN 0.81 types omit this standard web role. Keep the adaptation web-only.
export function radioRole(ref: unknown) {
  if (Platform.OS === "web") element(ref)?.setAttribute("role", "menuitemradio");
}
