"""Required local content projection at owned Hermes provider callbacks.

Provider URLs, authentication and transport stay with Hermes. The only callback
owner is the attested App adapter, scoped to one current profile registration.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
import weakref

_REGISTRATIONS = weakref.WeakKeyDictionary()
_CODE = "SECRET_MODEL_PROJECTION_UNAVAILABLE"


class ModelProjectionError(RuntimeError):
    def __init__(self):
        super().__init__(_CODE)
        self.code = _CODE


def register(ctx, callback):
    from shoggoth_managed_runtime import managed_selection_adapter_authority
    if not callable(callback) or managed_selection_adapter_authority(
        plugin_id=ctx.plugin_id, manifest_path=ctx.manifest.path, home=ctx._manager.home_path,
    ) is not True:
        raise ModelProjectionError()
    manager = ctx._manager
    gate = manager._selection_dispatch_gates.get(ctx.plugin_id)
    if gate is None:
        raise ModelProjectionError()
    entries = _REGISTRATIONS.setdefault(manager, {})
    if ctx.plugin_id in entries:
        raise ModelProjectionError()
    entry = {"callback": callback, "gate": gate,
             "proof": {"required_adapter_id": ctx.plugin_id, "adapter_generation": gate["generation"]}}
    return ctx._track_mapping_entry("model_projection", ctx.plugin_id, entries, entry, None)


def project(request):
    from shoggoth_managed_runtime import enabled, model_projection_owner
    if not enabled():
        return request
    stage = "owner"
    try:
        from hermes_constants import get_hermes_home
        from tui_gateway.selection_dispatch import _manager, _gate
        home = get_hermes_home()
        owner = model_projection_owner()
        stage = "registration"
        manager = _manager(home)
        entries = _REGISTRATIONS.get(manager, {})
        if len(entries) != 1:
            raise ModelProjectionError()
        entry = next(iter(entries.values()))
        stage = "adapter_gate"
        current_manager, current_gate = _gate(home, entry["proof"])
        if current_manager is not manager or current_gate is not entry["gate"]:
            raise ModelProjectionError()
        stage = "projection"
        safe = entry["callback"](request, {**owner, "api_request_id": "model-" + uuid.uuid4().hex})
        stage = "revalidation"
        if not isinstance(safe, dict) or model_projection_owner() != owner:
            raise ModelProjectionError()
        current_manager, current_gate = _gate(home, entry["proof"])
        if (current_manager is not manager or current_gate is not entry["gate"]
                or entries.get(entry["proof"]["required_adapter_id"]) is not entry):
            raise ModelProjectionError()
        return safe
    except Exception:
        # Never include request content, credentials or upstream exception text.
        logging.getLogger(__name__).warning("Model input protection stopped at stage=%s", stage)
        raise ModelProjectionError() from None


async def project_async(request):
    # ContextVars retain the native turn owner across this bounded local call.
    return await asyncio.to_thread(project, request)
