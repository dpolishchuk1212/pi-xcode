import SwiftUI

struct ContentView: View {
    // ERROR 1: Type annotation missing
    @State private var count = undefinedVariable

    var body: some View {
        VStack {
            // ERROR 2: Using a non-existent view
            NonExistentView()

            Text("Count: \(count)")

            Button("Increment") {
                // ERROR 3: Calling a method that doesn't exist
                count.invalidMethod()
            }
        }
        .padding()
    }
}

// ERROR 4: Conformance to non-existent protocol
struct BrokenModel: FakeProtocol {
    let name: String
    let value: Int

    // ERROR 5: Return type mismatch
    func calculate() -> String {
        return 42
    }
}
