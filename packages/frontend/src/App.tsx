import type { ReactElement } from 'react';
import { RouterProvider } from 'react-router';

import { appRouter } from './router';

export function App(): ReactElement {
  return <RouterProvider router={appRouter} />;
}
