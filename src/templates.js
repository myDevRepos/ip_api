exports.update_config_template = function (config, endpoint) {
  let js = `
  async function postData(url = '', data = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    return response.json();
  }

  function showMessage(message, type) {
    let node = document.getElementById('statusMessage');
    if (node) {
      node.parentNode.style = 'display: block';
      if (type == 'success') {
        node.parentNode.classList.add('is-primary');
      } else if (type == 'error') {
        node.parentNode.classList.add('is-danger');
      }
      node.innerText = message;
    }
  }
  
  document.getElementById('configSubmit').addEventListener('click', function() {
    try {
      var editor = ace.edit("editor");
      let parsed = JSON.parse(editor.getValue());
      let data = {
        newConfig: parsed
      }
      postData(window.location.href, data).then((msg) => {
        showMessage('Server Response: ' + msg.message, 'success');
      }).catch((err) => {
        showMessage('Error: ' + err.toString(), 'error');
      });
    } catch(err) {
      console.error(err)
    }
  });`;

  let formHtml = `
  <div class="field is-grouped">
    <div id="editor" style="width: 100%; height: 600px">${JSON.stringify(config, null, 2)}</div>
  </div>

  <script>
    var editor = ace.edit("editor");
    editor.getSession().setUseWorker(false);
    editor.setTheme("ace/theme/twilight");
    editor.getSession().setMode("ace/mode/json");
  </script>

<div class="field is-grouped">
  <div class="control">
    <button id="configSubmit" class="button is-link">Submit Config</button>
  </div>
</div>`;

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Edit Configuration</title>

      <script src="https://ajaxorg.github.io/ace-builds/src-min-noconflict/ace.js" type="text/javascript" charset="utf-8"></script>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css">
      <link href="https://cdn.jsdelivr.net/npm/ace-builds@1.15.0/css/ace.min.css" rel="stylesheet"></link>
  </head>
  <body>
   <section class="section my-6-desktop">
    <div class="container">
      <div class="content">
        <h2>Update Configuration</h2>
        <div style="display: none" class="notification is-light">
          <button class="delete" onclick="document.getElementById('statusMessage').parentNode.style = 'display: none'"></button>
          <div id="statusMessage"></div>
        </div>
        ${formHtml}
      </div>
      <script>
      ${js}
      </script>
    </div>
   </section>
  </body>`;
}