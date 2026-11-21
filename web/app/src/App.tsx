import { Make } from './make/Make';
import { Make as MakeViz } from './make-viz/Make';
import { Notes } from './notes/Notes';
import { HomeProvider } from './home';
import { Landing } from './Landing';
import { useArea } from './router';
import { Review } from './review/Review';
import { Teach } from './teach/App';

/**
 * The one app: each area is a path, and `/` shows where to go. Notes are the home store (opened once, kept open); the
 * workshops share their drafts; each lesson draft is its own store, synced with the teacher server. What the
 * workshops make is offered for the public site (web/site), and reviewed in /review.
 */
export function App() {
  const area = useArea();
  return (
    <HomeProvider>
      {area === '/' && <Landing />}
      {area === '/notes' && <Notes />}
      {area === '/make' && <Make />}
      {area === '/make-viz' && <MakeViz />}
      {area === '/teach' && <Teach />}
      {area === '/review' && <Review />}
    </HomeProvider>
  );
}
