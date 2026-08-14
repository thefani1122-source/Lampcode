---
name: react-production
description: React production conventions — component composition, memoization, effect cleanup, error boundaries, and controlled-input form patterns.
---

# React Production Best Practices

## Component Design
- Keep components small and focused — one responsibility per component
- Lift state only as high as needed; co-locate state with the component that owns it
- Prefer composition over prop-drilling; use context only for truly global state
- Use `React.memo` only when a component's parent re-renders often with unchanged props

## Performance
- Wrap expensive calculations in `useMemo`; wrap stable callbacks passed to child components in `useCallback`
- Never create functions or objects inline in JSX — they are new references on every render
- Use `key` props that are stable and unique; never use array index for dynamic or reorderable lists
- Lazy-load routes with `React.lazy` + `Suspense` to reduce initial bundle size

## State & Effects
- Prefer derived state over redundant state: compute from existing state/props instead of syncing
- Every `useEffect` that sets up a subscription, timer, or listener must return a cleanup function
- Use `useRef` for mutable values that must not trigger re-renders (DOM refs, interval IDs)
- Batch state updates: multiple `setState` calls inside event handlers are already batched in React 18

## Error Handling
- Wrap each page/route in an `ErrorBoundary` component to catch render errors gracefully
- Display user-friendly fallback UI on error; log the error to your monitoring service
- Always handle loading and error states when fetching data — never assume success

## Forms & Inputs
- Use controlled inputs (`value` + `onChange`) for form state that needs validation or formatting
- Avoid `useEffect` to sync form state — derive it directly from props or use a form library
- Validate on submit, not on every keystroke, unless UX explicitly requires live feedback

## TypeScript
- Type all component props with `interface`; export prop interfaces for shared components
- Avoid `as` type assertions — use type guards or conditional checks instead
- Use `React.FC` sparingly; prefer explicit return type annotations on function components
