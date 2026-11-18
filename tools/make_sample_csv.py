"""Write a sample book list in the Goodreads export format."""
import csv
import random
import sys

HEADER = ["Book Id", "Title", "Author", "Author l-f", "Additional Authors", "ISBN", "ISBN13", "My Rating",
          "Average Rating", "Publisher", "Binding", "Number of Pages", "Year Published",
          "Original Publication Year", "Date Read", "Date Added", "Bookshelves",
          "Bookshelves with positions", "Exclusive Shelf", "My Review", "Spoiler", "Private Notes",
          "Read Count", "Owned Copies"]

# title, author, pages, original publication year, binding
BOOKS = [
    ("Pride and Prejudice", "Jane Austen", 279, 1813, "Paperback"),
    ("Moby-Dick; or, The Whale", "Herman Melville", 720, 1851, "Paperback"),
    ("The Count of Monte Cristo", "Alexandre Dumas", 1276, 1844, "Paperback"),
    ("Jane Eyre", "Charlotte Brontë", 532, 1847, "Paperback"),
    ("Wuthering Heights", "Emily Brontë", 464, 1847, "Paperback"),
    ("Great Expectations", "Charles Dickens", 505, 1861, "Paperback"),
    ("A Tale of Two Cities", "Charles Dickens", 489, 1859, "Mass Market Paperback"),
    ("Crime and Punishment", "Fyodor Dostoevsky", 671, 1866, "Paperback"),
    ("The Brothers Karamazov", "Fyodor Dostoevsky", 796, 1880, "Paperback"),
    ("War and Peace", "Leo Tolstoy", 1392, 1869, "Hardcover"),
    ("Anna Karenina", "Leo Tolstoy", 964, 1878, "Paperback"),
    ("Les Misérables", "Victor Hugo", 1463, 1862, "Mass Market Paperback"),
    ("Don Quixote", "Miguel de Cervantes Saavedra", 1023, 1605, "Paperback"),
    ("Frankenstein: The 1818 Text", "Mary Wollstonecraft Shelley", 260, 1818, "Paperback"),
    ("Dracula", "Bram Stoker", 488, 1897, "Paperback"),
    ("The Picture of Dorian Gray", "Oscar Wilde", 272, 1890, "Paperback"),
    ("The Adventures of Sherlock Holmes (Sherlock Holmes, #3)", "Arthur Conan Doyle", 339, 1892, "Paperback"),
    ("The Hound of the Baskervilles (Sherlock Holmes, #5)", "Arthur Conan Doyle", 256, 1902, "Mass Market Paperback"),
    ("Treasure Island", "Robert Louis Stevenson", 311, 1883, "Paperback"),
    ("The Time Machine", "H.G. Wells", 118, 1895, "Mass Market Paperback"),
    ("The War of the Worlds", "H.G. Wells", 192, 1898, "Mass Market Paperback"),
    ("Twenty Thousand Leagues Under the Sea", "Jules Verne", 394, 1870, "Paperback"),
    ("Around the World in Eighty Days", "Jules Verne", 252, 1872, "Paperback"),
    ("The Odyssey", "Homer", 541, -700, "Paperback"),
    ("The Iliad", "Homer", 683, -750, "Paperback"),
    ("Meditations", "Marcus Aurelius", 254, 180, "Paperback"),
    ("The Divine Comedy", "Dante Alighieri", 798, 1320, "Hardcover"),
    ("Hamlet", "William Shakespeare", 289, 1601, "Mass Market Paperback"),
    ("Macbeth", "William Shakespeare", 249, 1606, "Mass Market Paperback"),
    ("Little Women", "Louisa May Alcott", 449, 1868, "Paperback"),
    ("Adventures of Huckleberry Finn", "Mark Twain", 327, 1884, "Paperback"),
    ("The Scarlet Letter", "Nathaniel Hawthorne", 279, 1850, "Paperback"),
    ("Walden", "Henry David Thoreau", 352, 1854, "Paperback"),
    ("Leaves of Grass", "Walt Whitman", 624, 1855, "Hardcover"),
    ("The Great Gatsby", "F. Scott Fitzgerald", 180, 1925, "Paperback"),
    ("Ulysses", "James Joyce", 783, 1922, "Paperback"),
    ("Mrs. Dalloway", "Virginia Woolf", 194, 1925, "Paperback"),
    ("The Metamorphosis", "Franz Kafka", 201, 1915, "Paperback"),
    ("The Trial", "Franz Kafka", 255, 1925, "Paperback"),
    ("Heart of Darkness", "Joseph Conrad", 188, 1899, "Paperback"),
    ("The Call of the Wild", "Jack London", 172, 1903, "Mass Market Paperback"),
    ("Anne of Green Gables (Anne of Green Gables, #1)", "L.M. Montgomery", 320, 1908, "Paperback"),
    ("The Secret Garden", "Frances Hodgson Burnett", 331, 1911, "Hardcover"),
    ("Alice's Adventures in Wonderland", "Lewis Carroll", 239, 1865, "Hardcover"),
    ("The Wonderful Wizard of Oz (Oz, #1)", "L. Frank Baum", 154, 1900, "Hardcover"),
    ("Peter Pan", "J.M. Barrie", 176, 1911, "Paperback"),
    ("Middlemarch", "George Eliot", 904, 1871, "Paperback"),
    ("Emma", "Jane Austen", 474, 1815, "Paperback"),
    ("Sense and Sensibility", "Jane Austen", 409, 1811, "Paperback"),
    ("Persuasion", "Jane Austen", 249, 1817, "Paperback"),
    ("Tess of the D'Urbervilles", "Thomas Hardy", 518, 1891, "Paperback"),
    ("Far From the Madding Crowd", "Thomas Hardy", 433, 1874, "Paperback"),
    ("The Three Musketeers", "Alexandre Dumas", 625, 1844, "Paperback"),
    ("Madame Bovary", "Gustave Flaubert", 329, 1857, "Paperback"),
    ("The Hunchback of Notre-Dame", "Victor Hugo", 510, 1831, "Paperback"),
    ("Candide", "Voltaire", 129, 1759, "Paperback"),
    ("Gulliver's Travels", "Jonathan Swift", 306, 1726, "Paperback"),
    ("Robinson Crusoe", "Daniel Defoe", 320, 1719, "Paperback"),
    ("Paradise Lost", "John Milton", 453, 1667, "Paperback"),
    ("The Canterbury Tales", "Geoffrey Chaucer", 504, 1400, "Paperback"),
    ("Beowulf", "Unknown", 245, 1000, "Paperback"),
    ("The Art of War", "Sun Tzu", 273, -500, "Hardcover"),
    ("The Prince", "Niccolò Machiavelli", 140, 1532, "Paperback"),
    ("On the Origin of Species", "Charles Darwin", 703, 1859, "Paperback"),
    ("The Republic", "Plato", 416, -375, "Paperback"),
    ("Uncle Tom's Cabin", "Harriet Beecher Stowe", 438, 1852, "Paperback"),
    ("The Jungle Book", "Rudyard Kipling", 277, 1894, "Hardcover"),
    ("Kim", "Rudyard Kipling", 366, 1901, "Paperback"),
    ("A Christmas Carol", "Charles Dickens", 184, 1843, "Hardcover"),
    ("Oliver Twist", "Charles Dickens", 608, 1838, "Paperback"),
    ("David Copperfield", "Charles Dickens", 882, 1850, "Paperback"),
    ("Bleak House", "Charles Dickens", 1017, 1853, "Paperback"),
    ("The Idiot", "Fyodor Dostoevsky", 667, 1869, "Paperback"),
    ("Notes from Underground", "Fyodor Dostoevsky", 136, 1864, "Paperback"),
    ("Dead Souls", "Nikolai Gogol", 464, 1842, "Paperback"),
    ("Fathers and Sons", "Ivan Turgenev", 244, 1862, "Paperback"),
    ("The Age of Innocence", "Edith Wharton", 293, 1920, "Paperback"),
    ("My Ántonia", "Willa Cather", 232, 1918, "Paperback"),
    ("The Awakening", "Kate Chopin", 195, 1899, "Paperback"),
    ("Sister Carrie", "Theodore Dreiser", 580, 1900, "Paperback"),
    ("The Wind in the Willows", "Kenneth Grahame", 197, 1908, "Hardcover"),
    ("Dubliners", "James Joyce", 207, 1914, "Paperback"),
    ("The Importance of Being Earnest", "Oscar Wilde", 76, 1895, "Paperback"),
    ("Swann's Way (In Search of Lost Time, #1)", "Marcel Proust", 615, 1913, "Paperback"),
    ("The Mysterious Affair at Styles (Hercule Poirot, #1)", "Agatha Christie", 208, 1920, "Mass Market Paperback"),
    ("Siddhartha", "Hermann Hesse", 152, 1922, "Paperback"),
    ("The Phantom of the Opera", "Gaston Leroux", 360, 1909, "Mass Market Paperback"),
    ("The Strange Case of Dr. Jekyll and Mr. Hyde", "Robert Louis Stevenson", 144, 1886, "Paperback"),
    ("Sons and Lovers", "D.H. Lawrence", 654, 1913, "Paperback"),
    ("The Thirty-Nine Steps (Richard Hannay, #1)", "John Buchan", 100, 1915, "Paperback"),
]

TO_READ = [
    ("The Magic Mountain", "Thomas Mann", 706, 1924, "Paperback"),
    ("Vanity Fair", "William Makepeace Thackeray", 867, 1848, "Paperback"),
    ("The Portrait of a Lady", "Henry James", 656, 1881, "Paperback"),
]
CURRENT = [("The Mill on the Floss", "George Eliot", 579, 1860, "Paperback")]


def main(path):
    rng = random.Random(7)
    rows = []
    day = 0
    for group, shelf in ((BOOKS, "read"), (CURRENT, "currently-reading"), (TO_READ, "to-read")):
        for title, author, pages, year, binding in group:
            day += rng.randint(12, 45)
            y, m, d = 2019 + day // 365, 1 + (day % 365) // 31, 1 + (day % 365) % 28
            date = f"{y}/{min(m, 12):02d}/{d:02d}"
            parts = author.split()
            lf = f"{parts[-1]}, {' '.join(parts[:-1])}" if len(parts) > 1 else author
            rating = rng.choice([3, 4, 4, 4, 5, 5]) if shelf == "read" else 0
            rows.append([str(1000 + len(rows)), title, author, lf, "", "", "", rating,
                         f"{rng.uniform(3.4, 4.4):.2f}", "", binding, pages, year + rng.randint(100, 180) if year < 1900 else 2003,
                         year, date if shelf == "read" else "", date, "" if shelf == "read" else shelf,
                         "", shelf, "", "", "", 1 if shelf == "read" else 0, 0])
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        writer.writerows(rows)
    print(len(rows), "rows ->", path)


if __name__ == "__main__":
    main(sys.argv[1])
