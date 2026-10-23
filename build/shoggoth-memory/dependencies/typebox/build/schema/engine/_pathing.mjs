// ------------------------------------------------------------------
// EncodeFragment
//
// We use this function to encode instancePath and schemaPath path
// fragments for errors. We need this encoding such that callers
// can use Pointer to deref error targets. We should consider adding
// this to the Pointer module as Pointer.Encode(...) (review)
// ------------------------------------------------------------------
export function EncodeFragment(fragment) {
    return fragment.replace(/~/g, '~0').replace(/\//g, '~1');
}
