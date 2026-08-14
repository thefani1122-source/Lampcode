---
name: frontend-sandbox
description: Vite + React Sandpack sandbox constraints — no fetch/localStorage/Node APIs, exact file structure, and the required package.json baseline.
---

# Frontend Sandbox Rules

You are building for a Vite + React sandboxed environment.

## What Works (use freely)
- React hooks (useState, useEffect, useContext, useRef, useMemo)
- react-router-dom for navigation
- recharts for charts and graphs
- lucide-react for icons
- CSS custom properties and animations
- Inline styles for dynamic values
- Local component state for everything

## What Breaks (never use)
- fetch() to external URLs → use mock data instead
- localStorage, sessionStorage → use React state
- window.location → use react-router navigate()
- Node.js APIs (fs, path, process)
- import from paths that don't exist in package.json

## File Structure (exact)
src/index.tsx     → ReactDOM.createRoot entry point
src/App.tsx       → main component with routing
src/styles.css    → global styles
package.json      → dependencies

## CSS Rules for Sandbox
- Keep global styles focused (variables + resets + layout)
- Component styles can be in styled-jsx or className
- Animations: CSS transitions (0.2s ease) are fine
- Hover effects: use CSS :hover or inline onMouseOver
- Do NOT import external CSS libraries not in package.json

## Package.json Must Include
At minimum:
{
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "react-router-dom": "^6.8.0"
}
Add others as needed.
Always include "type": "module"

## Common Mistakes to Avoid
1. Missing src/index.tsx → app won't start
2. ReactDOM.render() instead of createRoot() → React 18 error
3. Import from 'framer-motion' not in package.json → crash
4. Using fetch() → CORS error in sandbox
5. Forgetting router wrapper → useNavigate() crash
