#include <raptor2.h>
#include <stdio.h>
#include <string.h>

int main() {
    raptor_world* world = raptor_new_world();
    if (!world) { fprintf(stderr, "Failed to create raptor world\n"); return 1; }
    const char* ntriples = "<http://example.org/s> <http://example.org/p> <http://example.org/o> .\n";
    raptor_iostream* stream = raptor_new_iostream_from_string(world, (void*)ntriples, strlen(ntriples));
    if (!stream) { fprintf(stderr, "Failed to create iostream\n"); raptor_free_world(world); return 1; }
    raptor_free_iostream(stream);
    raptor_free_world(world);
    printf("Raptor2 WASM smoke test passed\n");
    return 0;
}
