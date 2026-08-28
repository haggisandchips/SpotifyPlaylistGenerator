import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GeneratorPanel } from './generator-panel';

describe('GeneratorPanel', () => {
  let component: GeneratorPanel;
  let fixture: ComponentFixture<GeneratorPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeneratorPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(GeneratorPanel);
    fixture.componentRef.setInput('userId', 'test-user');
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
