// The desktop portal's ScreenCast (M5b D2, D3): one monitor or window chosen by the person in
// the portal's dialog, the cursor in the picture when the portal can, the choice remembered
// with a restore token.

use std::os::fd::OwnedFd;

use ashpd::desktop::{
    PersistMode, ResponseError, Session,
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, StartCastOptions},
};

/// A started screen cast: the session (kept open as long as the capture runs) and the
/// PipeWire remote and node its stream is on.
pub(super) struct Started {
    pub screencast: Screencast,
    pub session: Session<Screencast>,
    pub remote: OwnedFd,
    pub node_id: u32,
    pub restore_token: Option<String>,
    pub size: Option<(i32, i32)>,
    pub source: &'static str,
    pub cursor: &'static str,
}

pub(super) enum Outcome {
    Started(Box<Started>),
    /// The person said no in the dialog.
    Cancelled,
}

fn cancelled(error: &ashpd::Error) -> bool {
    matches!(error, ashpd::Error::Response(ResponseError::Cancelled))
}

fn text(what: &str, error: ashpd::Error) -> String {
    format!("portal {what}: {error}")
}

/// Asks the portal for one source. A `restore_token` from an earlier capture is tried first,
/// so the portal may answer without a dialog.
pub(super) async fn start(restore_token: Option<String>) -> Result<Outcome, String> {
    let screencast = Screencast::new().await.map_err(|e| text("ScreenCast", e))?;
    let cursors = screencast.available_cursor_modes().await.map_err(|e| text("cursor modes", e))?;
    let types = screencast.available_source_types().await.map_err(|e| text("source types", e))?;
    let (cursor_mode, cursor) = if cursors.contains(CursorMode::EMBEDDED) {
        (CursorMode::EMBEDDED, "embedded")
    } else {
        (CursorMode::HIDDEN, "none")
    };
    let sources = types & (SourceType::MONITOR | SourceType::WINDOW);
    if sources.is_empty() {
        return Err(format!("the portal offers neither monitors nor windows (source types {types:?})"));
    }
    tracing::info!(
        version = screencast.version(),
        ?types,
        ?cursors,
        cursor,
        restore_token = restore_token.is_some(),
        "portal ScreenCast"
    );

    let session = screencast.create_session(Default::default()).await.map_err(|e| text("CreateSession", e))?;
    let options = SelectSourcesOptions::default()
        .set_cursor_mode(cursor_mode)
        .set_sources(sources)
        .set_multiple(false)
        .set_persist_mode(PersistMode::ExplicitlyRevoked)
        .set_restore_token(restore_token.as_deref());
    let selected = screencast.select_sources(&session, options).await;
    match selected.and_then(|request| request.response()) {
        Ok(()) => {}
        Err(e) if cancelled(&e) => return Ok(Outcome::Cancelled),
        Err(e) => return Err(text("SelectSources", e)),
    }
    let streams = match screencast.start(&session, None, StartCastOptions::default()).await.and_then(|r| r.response()) {
        Ok(streams) => streams,
        Err(e) if cancelled(&e) => return Ok(Outcome::Cancelled),
        Err(e) => return Err(text("Start", e)),
    };
    let Some(stream) = streams.streams().first() else {
        return Err("the portal started a screen cast without a stream".into());
    };
    let source = match stream.source_type() {
        Some(t) if t.contains(SourceType::WINDOW) => "window",
        Some(t) if t.contains(SourceType::MONITOR) => "monitor",
        Some(_) => "virtual",
        None => "unknown",
    };
    let node_id = stream.pipe_wire_node_id();
    let size = stream.size();
    let restore_token = streams.restore_token().map(str::to_owned);
    let remote = screencast
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|e| text("OpenPipeWireRemote", e))?;
    tracing::info!(node_id, ?size, source, restore_token = restore_token.is_some(), "portal screen cast started");
    Ok(Outcome::Started(Box::new(Started {
        screencast,
        session,
        remote,
        node_id,
        restore_token,
        size,
        source,
        cursor,
    })))
}
