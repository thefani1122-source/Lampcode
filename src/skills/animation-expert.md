---
name: animation-expert
description: Task-scoped Motion, GSAP, Lenis, Three.js/React Three Fiber and Spline guidance for animated or 3D experiences.
---

# Animation and 3D — choose the smallest appropriate tool

Animation is an enhancement, not a requirement. A business site, SaaS dashboard, form-heavy app or data table can be excellent with no motion. Never add movement to every section just to make a site feel animated.

## Choose by need

- CSS transitions: hover, focus, reveal and simple state changes. Prefer this first; no package required.
- Motion: component state transitions, mount/unmount, drag and modest gestures. Install motion; import from motion/react. In Next.js, use a small Client Component.
- GSAP: complex timelines, ScrollTrigger, pinned sections or sequencing across multiple elements. Install gsap; register only plugins used.
- Lenis: long-form visual storytelling where smooth scrolling is a deliberate part of the experience. Install lenis; preserve native keyboard/focus behavior.
- Three.js + React Three Fiber + Drei: interactive 3D scenes, product configurators or spatial experiences. Install three, @react-three/fiber and @react-three/drei. LampCode uses React 19, so use React-19-compatible Fiber v9. Lazy-load Canvas and provide a lightweight fallback.
- Spline: install @splinetool/react-spline only when the user provides a real scene URL or requests a clearly identified placeholder. Never invent a scene ID.

## Implementation rules

- All animation code must preserve content and functionality when JavaScript/WebGL is unavailable.
- Respect prefers-reduced-motion. Avoid parallax, looping movement and large transitions for users who opt out.
- Do not animate critical data, validation messages or navigation in a way that makes them difficult to read or operate.
- Avoid global cursor replacement, scroll hijacking and excessive autoplay videos/particles.
- In Next.js, DOM/WebGL/animation imports stay in Client Components. Never import them from Server Components or server routes.
- Add packages only when imported. LampCode installs detected npm dependencies before preview startup.
- Verify the page after animation is added: desktop/mobile overflow, console errors, interactions and reduced-motion behavior.
