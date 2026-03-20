import Foundation

/// A simple calculator for testing purposes.
struct Calculator {
    func add(_ a: Int, _ b: Int) -> Int {
        return a + b
    }

    func subtract(_ a: Int, _ b: Int) -> Int {
        return a - b
    }

    func multiply(_ a: Int, _ b: Int) -> Int {
        return a * b
    }

    func divide(_ a: Double, _ b: Double) -> Double? {
        guard b != 0 else { return nil }
        return a / b
    }

    func factorial(_ n: Int) -> Int {
        guard n >= 0 else { return -1 }
        if n <= 1 { return 1 }
        return n * factorial(n - 1)
    }
}
