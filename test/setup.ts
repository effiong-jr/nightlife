// Adds DOM matchers (toBeInTheDocument, ...). Component tests opt into jsdom with
// a `// @vitest-environment jsdom` comment; everything else runs in node.
import "@testing-library/jest-dom/vitest";
