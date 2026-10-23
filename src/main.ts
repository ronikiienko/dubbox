import './style.css';
import { openInitial } from './library';
import { emptyProject } from './state';
import { mountUI } from './ui';

openInitial()
  .catch((e) => {
    // no IndexedDB (some private modes): the app still works, songs just aren't kept
    console.error(e);
    alert('This browser won’t let DUBBOX store projects, so nothing will be saved. Use COPY or FILE in PROJECTS to keep your work.');
    return emptyProject();
  })
  .then((p) => mountUI(document.getElementById('app')!, p));
