import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';

import { RouterService } from '~/services';

@Component({
  selector: 'lab-id',
  template: '<router-outlet>',
  standalone: true,
  imports: [RouterOutlet],
})
export class IdComponent implements OnInit {
  route = inject(ActivatedRoute);
  router = inject(Router);
  routerSvc = inject(RouterService);

  ngOnInit(): void {
    this.routerSvc.initialize(this.route);
  }
}
