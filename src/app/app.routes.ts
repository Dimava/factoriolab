import { Routes } from '@angular/router';

import { canActivateId, canActivateLanding } from './guards';

export const routes: Routes = [
  {
    path: ':id',
    canActivate: [canActivateId],
    loadComponent: () =>
      import('./routes/id.component').then((c) => c.IdComponent),
    children: [
      {
        path: 'wizard',
        loadComponent: () =>
          import('./routes/wizard/wizard.component').then(
            (c) => c.WizardComponent,
          ),
      },
      {
        path: '',
        pathMatch: 'full',
        canActivate: [canActivateLanding],
        loadComponent: () =>
          import('./routes/landing/landing.component').then(
            (c) => c.LandingComponent,
          ),
      },
      {
        path: '',
        loadChildren: () =>
          import('./routes/main/main.routes').then((m) => m.routes),
      },
    ],
  },
  {
    path: '**',
    redirectTo: '1.1',
  },
];
