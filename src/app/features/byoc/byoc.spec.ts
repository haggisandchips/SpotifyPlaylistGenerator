import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Byoc } from './byoc';

describe('Byoc', () => {
  let component: Byoc;
  let fixture: ComponentFixture<Byoc>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Byoc],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Byoc);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
